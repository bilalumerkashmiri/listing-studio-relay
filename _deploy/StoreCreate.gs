/**
 * StoreCreate.gs — one-click "Create New Store" (owner, or an administrator the owner allowed: V5.3).
 *
 * The web app runs as the owner, so the new spreadsheet is created in the OWNER's Drive by
 * copying the clean master template with Spreadsheet.copy(). The master and every existing
 * store are only ever READ here, never written.
 *
 * Safe against repeated clicks / network retries / partial failure:
 *  - The browser makes one random requestId per opened form. The server remembers it
 *    (CREQ_<requestId>) together with a fingerprint of the form, the spreadsheet it copied and
 *    the storeId it chose. A retry with the same requestId RESUMES the same store; it never
 *    makes a second copy. The same requestId with a different form is refused.
 *  - A short cache marker stops two simultaneous requests with the same id from running the
 *    setup at once (the second gets BUSY and retries).
 *  - The store is registered (STORE_<id>) only AFTER the new sheet has been copied, stamped and
 *    verified empty. Until then the sheet is inert: its identity stamp matches no store.
 */

var CREQ_PREFIX_ = 'CREQ_';
var REQUEST_ID_RE_ = /^[a-f0-9]{32}$/;
var MAX_TRIGGERS_ = 20;            // Apps Script limit: 20 triggers per user per script
var CREATE_RATE_MAX_ = 5;          // new stores per 10 minutes
var CREATE_RATE_TTL_S_ = 600;
var CREQ_KEEP_MS_ = 14 * 24 * 60 * 60 * 1000;

function parseEmailList_(arr, label) {
  var out = [];
  var seen = {};
  (arr || []).forEach(function (item) {
    if (typeof item !== 'string') throw apiError_('INVALID', 'Malformed request.');
    // Accept "a@x.com, b@y.com" or one per line.
    item.split(/[\s,;]+/).forEach(function (piece) {
      if (!piece) return;
      var e = parseEmail_(piece);
      if (!seen[e]) { seen[e] = true; out.push(e); }
    });
  });
  if (out.length > MAX_MEMBERS_) throw apiError_('INVALID', 'Too many ' + label + ' addresses (max ' + MAX_MEMBERS_ + ').');
  return out;
}

function readCreq_(requestId) {
  var raw = scriptProp_(CREQ_PREFIX_ + requestId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function writeCreq_(requestId, rec) {
  PropertiesService.getScriptProperties().setProperty(CREQ_PREFIX_ + requestId, JSON.stringify(rec));
}

function pruneCreq_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  for (var k in all) {
    if (k.indexOf(CREQ_PREFIX_) !== 0) continue;
    try {
      var r = JSON.parse(all[k]);
      if (r && r.state === 'done' && Date.now() - (r.t || 0) > CREQ_KEEP_MS_ && typeof props.deleteProperty === 'function') props.deleteProperty(k);
    } catch (e) { /* leave unreadable records alone */ }
  }
}

function createResult_(store, owner, warnings) {
  var out = { storeId: store.id, name: store.name, appUrl: appUrlFor_(store.id), warnings: warnings || [] };
  if (owner) out.sheetUrl = sheetUrlFor_(store);
  return out;
}

/**
 * @param {string} actor verified lower-case email (already confirmed to be the owner by dispatch_)
 * @param {{requestId:string,name:string,admins:string[],team:string[]}} p
 */
function createStore_(actor, p) {
  if (!canCreateStores_(actor)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
  if (scriptProp_('SIGNING_KEY').length < 32) throw apiError_('SERVER', 'Server is not configured.');

  // ---- 1. validate (nothing is created if anything here fails) ----
  if (typeof p.requestId !== 'string' || !REQUEST_ID_RE_.test(p.requestId)) throw apiError_('INVALID', 'Malformed request.');
  var nm = normalizeStoreName_(p.name);
  if (!nm.ok) throw apiError_('INVALID', nm.message);
  var shop = parseEtsyShopUrl_(p.etsyUrl);
  if (!shop.ok) throw apiError_('INVALID', shop.message);
  var admins = parseEmailList_(p.admins, 'administrator');
  var team = parseEmailList_(p.team, 'team member');
  var actorEmail = String(actor).toLowerCase();
  var ownerEmail = scriptProp_('OWNER_EMAIL').toLowerCase();
  var byOwner = isOwner_(actorEmail);
  // An administrator who creates a store may add team members, but cannot hand out administrator rights.
  if (!byOwner && admins.length) throw apiError_('FORBIDDEN', 'Only the system owner can add other administrators when creating a store.');
  admins = admins.filter(function (e) { return e !== actorEmail && e !== ownerEmail; });
  team = team.filter(function (e) { return e !== actorEmail && e !== ownerEmail; });
  var both = admins.filter(function (e) { return team.indexOf(e) !== -1; });
  if (both.length) throw apiError_('INVALID', both[0] + ' is in both lists. Choose Administrator or Team Member.');
  if (admins.length + team.length + 1 > MAX_MEMBERS_) throw apiError_('INVALID', 'Too many people (max ' + MAX_MEMBERS_ + ').');
  var fp = sha256hex_(JSON.stringify([nm.name, admins, team, shop.url, actorEmail]));

  // ---- 2. idempotency + single-flight (short lock) ----
  var cache = loginCache_();
  var rec = withLock_(function () {
    var r = readCreq_(p.requestId);
    if (r && r.fp !== fp) throw apiError_('INVALID', 'This request was already used for a different store. Close the form and start again.');
    if (r && r.state === 'done') return r;
    if (cache.get('creating_' + p.requestId)) throw apiError_('BUSY', 'This store is still being created. Please wait a moment.');
    if (!r) {
      if (cache.get('create_rate') && Number(cache.get('create_rate')) >= CREATE_RATE_MAX_) {
        throw apiError_('BUSY', 'Too many stores were created just now. Please wait a few minutes.');
      }
      if (ScriptApp.getProjectTriggers().length >= MAX_TRIGGERS_) { try { reclaimDeletedStoreTriggers_(); } catch (e0) { /* fall through to the limit message */ } }
      if (ScriptApp.getProjectTriggers().length >= MAX_TRIGGERS_) {
        throw apiError_('INVALID', 'This project has reached the Google limit of ' + MAX_TRIGGERS_ + ' stores (one sheet trigger each). Nothing was created.');
      }
      cache.put('create_rate', String((Number(cache.get('create_rate')) || 0) + 1), CREATE_RATE_TTL_S_);
      r = { state: 'new', fp: fp, t: Date.now(), storeId: '', ssId: '' };
      writeCreq_(p.requestId, r);
    }
    cache.put('creating_' + p.requestId, '1', 120);
    return r;
  });
  if (rec.state === 'done') {
    var existing = getStore_(rec.storeId);
    if (existing) return createResult_(existing, byOwner, rec.warnings || []);
    throw apiError_('INVALID', 'This store was already created and has since been removed. Close the form and start again.');
  }

  try {
    // ---- 3. master template: must exist and be clean; it is never modified ----
    if (!rec.ssId) {
      var masterId = scriptProp_('MASTER_TEMPLATE_ID');
      if (!masterId) throw apiError_('SERVER', 'The master template is not set up.');
      var master = SpreadsheetApp.openById(masterId);
      var mSheet = master.getSheetByName(LISTINGS_SHEET_);
      var mMeta = master.getSheetByName(META_SHEET_);
      var mStamp = mMeta ? String(mMeta.getRange(1, 2).getValue()) : '';
      if (!mSheet || (mSheet.getLastRow() > 1) || mStamp) {
        throw apiError_('SERVER', 'The master template is not clean, so no store was created. Nothing was changed.');
      }
      // ---- 4. independent copy (a brand-new spreadsheet file) ----
      var copy = master.copy(nm.name);
      rec.ssId = copy.getId();
      do { rec.storeId = Utilities.getUuid().replace(/-/g, '').slice(0, 12); } while (getStore_(rec.storeId));
      rec.state = 'copied';
      writeCreq_(p.requestId, rec);
    }

    var ss = SpreadsheetApp.openById(rec.ssId);
    if (rec.ssId === scriptProp_('MASTER_TEMPLATE_ID') || findStoreBySpreadsheetId_(rec.ssId)) {
      // Can only happen through a corrupted request record. Refuse rather than touch a real sheet.
      throw apiError_('SERVER', 'Setup stopped for safety. Nothing was changed.');
    }
    try { ss.rename(nm.name); } catch (e) { /* optional */ }

    // ---- 5. formatting, protections, hidden identity stamp (idempotent) ----
    prepareSpreadsheet_(ss, rec.storeId);

    // ---- 6. the new store must start empty ----
    var sheet = ss.getSheetByName(LISTINGS_SHEET_);
    if (!sheet || sheet.getLastRow() > 1) throw apiError_('SERVER', 'The new sheet is not empty. Setup stopped; nothing was registered.');

    // ---- 7. register + permissions (owner is always an administrator and access manager) ----
    var now = new Date().toISOString();
    var members = [];
    if (ownerEmail) members.push({ email: ownerEmail, role: 'admin', manager: true, status: 'active', added: now, by: actorEmail });
    if (!byOwner) members.push({ email: actorEmail, role: 'admin', manager: false, status: 'active', added: now, by: actorEmail });   // the creator administers only this new store
    admins.forEach(function (e) { members.push({ email: e, role: 'admin', manager: false, status: 'active', added: now, by: actorEmail }); });
    team.forEach(function (e) { members.push({ email: e, role: 'team', manager: false, status: 'active', added: now, by: actorEmail }); });
    withLock_(function () {
      if (!getStore_(rec.storeId)) {
        saveStore_({ id: rec.storeId, spreadsheetId: rec.ssId, name: nm.name, etsyStoreUrl: shop.url, members: members });
      }
    });

    // ---- 8. direct-edit automation (non-fatal: the app still validates rows when it opens) ----
    var warnings = [];
    try { installEditTrigger_(rec.ssId); } catch (e2) {
      warnings.push('Direct edits made inside the Google Sheet will only be checked when the app is next opened (automatic sheet trigger could not be installed).');
    }

    // ---- 9. verify ----
    var store = getStore_(rec.storeId);
    if (!store || store.spreadsheetId !== rec.ssId || roleFor_(store, actorEmail) !== 'admin') throw apiError_('SERVER', 'Verification failed: store registration.');
    var opened = openStoreSheet_(store);
    if (readRecords_(opened.sheet).length !== 0) throw apiError_('SERVER', 'Verification failed: the new store is not empty.');
    var st = buildState_(store, 'admin', actorEmail, [], getRev_(store.id));
    if (st.counts.total !== 0 || st.counts.completed !== 0 || st.counts.remaining !== 0 || st.counts.errors !== 0) throw apiError_('SERVER', 'Verification failed: counters.');

    rec.state = 'done';
    rec.warnings = warnings;
    rec.t = Date.now();
    withLock_(function () { writeCreq_(p.requestId, rec); pruneCreq_(); bumpRev_(store.id); });
    return createResult_(store, byOwner, warnings);
  } catch (err) {
    if (err && err.isApiError) throw err;
    console.error('createStore failed at state ' + rec.state + ': ' + (err && err.stack ? err.stack : err));
    throw apiError_('SERVER', 'Setting up the store did not finish. Nothing existing was changed. Press Create Store again: it continues where it stopped and never creates a duplicate.');
  } finally {
    cache.remove('creating_' + p.requestId);
  }
}
