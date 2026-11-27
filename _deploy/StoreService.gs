/**
 * StoreService.gs — per-store configuration.
 *
 * The registry lives in Script Properties of the owner's PRIVATE standalone Apps
 * Script project (one property per store: STORE_<id>). Spreadsheet editors can never
 * read or edit it. Each store maps to exactly one spreadsheet, and the spreadsheet
 * carries a hidden "_Meta" stamp with its storeId so a COPIED spreadsheet that has
 * not been registered can never be served under another store's identity.
 */

var LISTINGS_SHEET_ = 'Listings';
var META_SHEET_ = '_Meta';
var STORE_ID_RE_ = /^[a-z0-9]{8,32}$/;
var DISPLAY_TZ_ = 'Asia/Karachi';

function isValidStoreId_(id) {
  return typeof id === 'string' && STORE_ID_RE_.test(id);
}

function getStore_(storeId) {
  if (!isValidStoreId_(storeId)) return null;
  var raw = scriptProp_('STORE_' + storeId);
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    s.members = normalizeMembers_(s);
    s.etsyStoreUrl = typeof s.etsyStoreUrl === 'string' ? s.etsyStoreUrl : '';   // optional; absent on V5.2 stores
    // Derived, ACTIVE-only lists. A disabled member is in neither list, so every
    // role check below (roleFor_) denies them without any special case.
    s.admins = s.members.filter(function (m) { return m.role === 'admin' && m.status === 'active'; }).map(function (m) { return m.email; });
    s.team = s.members.filter(function (m) { return m.role === 'team' && m.status === 'active'; }).map(function (m) { return m.email; });
    return s;
  } catch (e) {
    return null;
  }
}

/**
 * Members are stored as [{email, role, manager, status, added, by}]. Stores registered by the
 * original V5 code only have admins[] / team[]; those are read as active members with no
 * "added" date and no manager flag (nothing is rewritten until the first team change).
 */
function normalizeMembers_(s) {
  var out = [];
  var seen = {};
  function push(email, role, manager, status, added, by) {
    var e = String(email || '').trim().toLowerCase();
    if (!e || seen[e]) return;
    seen[e] = true;
    out.push({
      email: e,
      role: role === 'admin' ? 'admin' : 'team',
      manager: role === 'admin' && manager === true,
      status: status === 'disabled' ? 'disabled' : 'active',
      added: typeof added === 'string' ? added : '',
      by: typeof by === 'string' ? by : ''
    });
  }
  if (Array.isArray(s.members)) {
    s.members.forEach(function (m) { if (m && typeof m === 'object') push(m.email, m.role, m.manager, m.status, m.added, m.by); });
  } else {
    (s.admins || []).forEach(function (x) { push(x, 'admin', false, 'active', '', ''); });
    (s.team || []).forEach(function (x) { push(x, 'team', false, 'active', '', ''); });
  }
  return out;
}

/** Rebuilds members from plain admin/team lists, keeping metadata for people who stay. */
function membersFromLists_(admins, team, previous) {
  var prev = {};
  (previous || []).forEach(function (m) { prev[m.email] = m; });
  var out = [];
  var seen = {};
  function add(e, role) {
    if (seen[e]) return;
    seen[e] = true;
    var o = prev[e];
    out.push({
      email: e, role: role, manager: role === 'admin' && !!(o && o.manager), status: 'active',
      added: o ? o.added : '', by: o ? o.by : ''
    });
  }
  admins.forEach(function (e) { add(e, 'admin'); });
  team.forEach(function (e) { add(e, 'team'); });
  return out;
}

function saveStore_(store) {
  var members = Array.isArray(store.members) ? store.members : normalizeMembers_(store);
  var rec = {
    id: store.id,
    spreadsheetId: store.spreadsheetId,
    name: store.name,
    members: members,
    // Active-only copies keep the record readable by the original V5 code (safe rollback).
    admins: members.filter(function (m) { return m.role === 'admin' && m.status === 'active'; }).map(function (m) { return m.email; }),
    team: members.filter(function (m) { return m.role === 'team' && m.status === 'active'; }).map(function (m) { return m.email; })
  };
  if (store.etsyStoreUrl) rec.etsyStoreUrl = store.etsyStoreUrl;   // never written for stores without one
  var json = JSON.stringify(rec);
  if (json.length > 8500) throw apiError_('INVALID', 'This store has too many members to save. Remove some first.');
  PropertiesService.getScriptProperties().setProperty('STORE_' + store.id, json);
}

function listStores_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var out = [];
  for (var k in all) {
    if (k.indexOf('STORE_') === 0) {
      var s = getStore_(k.slice(6));
      if (s) out.push(s);
    }
  }
  return out;
}

function findStoreBySpreadsheetId_(spreadsheetId) {
  var stores = listStores_();
  for (var i = 0; i < stores.length; i++) if (stores[i].spreadsheetId === spreadsheetId) return stores[i];
  return null;
}

/** Opens the store's spreadsheet and verifies the identity stamp. Throws on mismatch. */
function openStoreSheet_(store) {
  var ss = SpreadsheetApp.openById(store.spreadsheetId);
  var meta = ss.getSheetByName(META_SHEET_);
  var stamp = meta ? String(meta.getRange(1, 2).getValue()) : '';
  var stampSs = meta ? String(meta.getRange(2, 2).getValue()) : '';
  if (stamp !== store.id || stampSs !== store.spreadsheetId) {
    throw apiError_('DENIED', 'This store is not available.');
  }
  var sheet = ss.getSheetByName(LISTINGS_SHEET_);
  if (!sheet) throw apiError_('SERVER', 'Store data sheet is missing.');
  return { ss: ss, sheet: sheet };
}

/* ---------- revision counter (lightweight change detection for polling) ---------- */

function getRev_(storeId) {
  return Number(scriptProp_('REV_' + storeId)) || 0;
}

function bumpRev_(storeId) {
  var next = getRev_(storeId) + 1;
  PropertiesService.getScriptProperties().setProperty('REV_' + storeId, String(next));
  return next;
}

/* ---------- locking ---------- */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (e) {
    throw apiError_('BUSY', 'The tracker is busy. Please try again in a moment.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- settings ---------- */

/** Renames the store and (V5.3) optionally sets/clears its Etsy shop URL. etsyUrl undefined = leave unchanged. */
function saveStoreName_(store, rawName, etsyUrl) {
  var n = normalizeStoreName_(rawName);
  if (!n.ok) throw apiError_('INVALID', n.message);
  var shop = null;
  if (etsyUrl !== undefined) {
    shop = parseEtsyShopUrl_(etsyUrl);
    if (!shop.ok) throw apiError_('INVALID', shop.message);
  }
  return withLock_(function () {
    var fresh = getStore_(store.id);
    if (!fresh) throw apiError_('DENIED', 'This store is not available.');
    fresh.name = n.name;
    if (shop) fresh.etsyStoreUrl = shop.url;
    saveStore_(fresh);
    try { SpreadsheetApp.openById(fresh.spreadsheetId).rename(n.name); } catch (e) { /* optional */ }
    bumpRev_(store.id);
    return { name: n.name, etsyStoreUrl: getStore_(store.id).etsyStoreUrl };
  });
}
