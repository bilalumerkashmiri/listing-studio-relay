/**
 * Access.gs — V5.3 centralized "Manage Users & Access" (owner only) + account-level switches.
 *
 * ONE source of truth for who may open which store: the per-store `members` list inside each
 * private STORE_<id> registry record (the same data the per-store "Manage Team" panel edits).
 * Nothing here keeps a second copy of store roles. Central saves read and write those records
 * under the script lock, so a change made here shows up in Manage Team and vice versa.
 *
 * The only new data is a tiny per-person ACCOUNT record  UACC_<id>  with two switches:
 *   disabled   global account switch. A disabled account is denied on EVERY store at once
 *              (roleFor_), but all of its store assignments are kept, so Restore brings back
 *              exactly the previous access and nothing else.
 *   canCreate  "Allow New Store Creation". Only effective while the account is enabled AND has at
 *              least one active Administrator assignment. Never granted by migration.
 * plus a small private permission-change log (PERMLOG) and one-time backups of each store record
 * (BAK53_<id>, written the first time that store is touched, so the V5.2 state can be recovered).
 *
 * Every function here ends in "_" (not web-callable). They run only through api() -> dispatch_(),
 * which authenticates the caller and checks the owner permission BEFORE anything below executes;
 * each function re-checks the owner itself (defence in depth).
 */

var UACC_PREFIX_ = 'UACC_';
var BAK53_PREFIX_ = 'BAK53_';
var PERMLOG_KEY_ = 'PERMLOG';
var PERMLOG_MAX_CHARS_ = 8000;
var ASSIGN_ROLES_ = { admin: true, team: true, none: true };

function acctKey_(email) {
  return UACC_PREFIX_ + Utilities.base64EncodeWebSafe(String(email).toLowerCase()).replace(/=+$/, '');
}

function getAcct_(email) {
  var raw = scriptProp_(acctKey_(email));
  var a = { email: String(email).toLowerCase(), disabled: false, canCreate: false, exists: false };
  if (!raw) return a;
  try {
    var o = JSON.parse(raw);
    a.disabled = o.disabled === true;
    a.canCreate = o.canCreate === true;
    a.exists = true;
  } catch (e) { /* unreadable record = defaults (enabled, no creation right) */ }
  return a;
}

function saveAcct_(email, disabled, canCreate, actor) {
  var rec = { email: String(email).toLowerCase(), disabled: disabled === true, canCreate: canCreate === true, by: String(actor).toLowerCase(), t: new Date().toISOString() };
  PropertiesService.getScriptProperties().setProperty(acctKey_(email), JSON.stringify(rec));
}

/** True when the owner switched this Google account off everywhere. The owner can never be disabled. */
function isAccountDisabled_(email) {
  var e = String(email || '').toLowerCase();
  if (!e || isOwner_(e)) return false;
  return getAcct_(e).disabled;
}

/** Owner always; otherwise an enabled account the owner allowed AND that still administers at least one store. */
function canCreateStores_(email) {
  var e = String(email || '').toLowerCase();
  if (!e) return false;
  if (isOwner_(e)) return true;
  var a = getAcct_(e);
  if (a.disabled || !a.canCreate) return false;
  var stores = listStores_();
  for (var i = 0; i < stores.length; i++) if (stores[i].admins.indexOf(e) !== -1) return true;
  return false;
}

/* ---------- audit + backup ---------- */

function logPerm_(entries) {
  if (!entries.length) return;
  var props = PropertiesService.getScriptProperties();
  var list = [];
  try { list = JSON.parse(props.getProperty(PERMLOG_KEY_) || '[]'); } catch (e) { list = []; }
  entries.forEach(function (e) { list.push(e); });
  var json = JSON.stringify(list);
  while (json.length > PERMLOG_MAX_CHARS_ && list.length > 1) { list.shift(); json = JSON.stringify(list); }
  props.setProperty(PERMLOG_KEY_, json);
}

/** Keeps the FIRST-SEEN (V5.2) record of a store so a bad permission change can always be undone by hand. */
function ensureBackup_(storeId) {
  var raw = scriptProp_('STORE_' + storeId);
  if (raw && !scriptProp_(BAK53_PREFIX_ + storeId)) PropertiesService.getScriptProperties().setProperty(BAK53_PREFIX_ + storeId, raw);
}

/* ---------- read model ---------- */

function summarizeRoles_(roles) {
  var a = 0, t = 0;
  roles.forEach(function (r) { if (r === 'admin') a++; else if (r === 'team') t++; });
  if (!a && !t) return 'none';
  if (a && t) return 'mixed';
  return a ? 'admin' : 'team';
}

/**
 * Everything the owner screen needs, derived from the live registry:
 *  stores: active registered stores; users: one row per normalized email.
 */
function accessView_(actor) {
  if (!isOwner_(actor)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
  var owner = scriptProp_('OWNER_EMAIL').toLowerCase();
  var stores = listStores_().map(function (s) { return { id: s.id, name: s.name }; });
  stores.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : (a.id < b.id ? -1 : 1); });
  var users = {};
  function user(e) {
    if (!users[e]) users[e] = { email: e, owner: e === owner, stores: {}, suspendedStores: 0 };
    return users[e];
  }
  listStores_().forEach(function (s) {
    (s.members || []).forEach(function (m) {
      if (m.email === owner) return;
      var u = user(m.email);
      if (m.status === 'active') u.stores[s.id] = m.role; else u.suspendedStores++;
    });
  });
  var all = PropertiesService.getScriptProperties().getProperties();
  for (var k in all) {
    if (k.indexOf(UACC_PREFIX_) !== 0) continue;
    try { var o = JSON.parse(all[k]); if (o && typeof o.email === 'string' && o.email !== owner) user(o.email.toLowerCase()); } catch (e) { /* skip unreadable */ }
  }
  var rows = Object.keys(users).sort().map(function (e) {
    var u = users[e], a = getAcct_(e), ids = Object.keys(u.stores);
    var roles = ids.map(function (id) { return u.stores[id]; });
    return {
      email: e, owner: false, disabled: a.disabled, canCreate: a.canCreate,
      stores: u.stores, storeCount: ids.length, suspendedStores: u.suspendedStores,
      summary: summarizeRoles_(roles),
      canCreateNow: canCreateStores_(e)
    };
  });
  var ownerRow = owner ? { email: owner, owner: true, disabled: false, canCreate: true, stores: {}, storeCount: stores.length, suspendedStores: 0, summary: 'owner', canCreateNow: true } : null;
  return { stores: stores, users: (ownerRow ? [ownerRow] : []).concat(rows), owner: owner, storeCount: stores.length, userCount: rows.length + (owner ? 1 : 0) };
}

function listAccess_(actor) { return accessView_(actor); }

/* ---------- the one write path ---------- */

function sortedKeys_(o) { return Object.keys(o || {}).sort(); }

/**
 * @param {string} actor  verified owner email
 * @param {{email:string,isNew?:boolean,assignments:Object,base:Object,canCreate:boolean,disabled:boolean,confirm?:boolean}} p
 *   assignments : { storeId: 'admin'|'team'|'none' } for the stores the owner is changing/keeping (client sends all)
 *   base        : { assignments:{storeId:role}, canCreate, disabled }  what the owner screen last loaded
 */
function saveUserAccess_(actor, p) {
  if (!isOwner_(actor)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
  var email = parseEmail_(p.email);
  if (isOwner_(email)) throw apiError_('FORBIDDEN', 'The system owner cannot be changed.');
  if (String(actor).toLowerCase() === email) throw apiError_('FORBIDDEN', 'You cannot change your own access.');
  var assign = p.assignments, base = p.base;
  if (!assign || typeof assign !== 'object' || Array.isArray(assign)) throw apiError_('INVALID', 'Malformed request.');
  if (!base || typeof base !== 'object' || Array.isArray(base) || !base.assignments || typeof base.assignments !== 'object') throw apiError_('INVALID', 'Malformed request.');
  if (typeof p.canCreate !== 'boolean' || typeof p.disabled !== 'boolean') throw apiError_('INVALID', 'Malformed request.');
  var ids = Object.keys(assign);
  if (ids.length > 200) throw apiError_('INVALID', 'Too many stores in one request.');
  ids.forEach(function (id) {
    if (!isValidStoreId_(id)) throw apiError_('INVALID', 'Unknown store.');
    if (typeof assign[id] !== 'string' || !ASSIGN_ROLES_[assign[id]]) throw apiError_('INVALID', 'Choose No Access, Administrator or Team Member.');
  });
  var wantCreate = p.canCreate === true, wantDisabled = p.disabled === true;

  return withLock_(function () {
    // fresh read of every store involved + validation of ids against the live registry
    var current = {};          // storeId -> active role | 'none'
    var fresh = {};
    var problems = [];
    ids.forEach(function (id) {
      var s = getStore_(id);
      if (!s) { problems.push(id); return; }
      fresh[id] = s;
      var m = findMember_(s, email);
      current[id] = m && m.status === 'active' ? m.role : 'none';
    });
    if (problems.length) throw apiError_('INVALID', 'One of those stores no longer exists. Reload and try again.');
    var acct = getAcct_(email);

    // ---- stale-update guard: the owner screen must still match reality ----
    var b = base.assignments;
    var stale = ids.some(function (id) { return (b[id] || 'none') !== current[id]; }) ||
      (base.canCreate === true) !== acct.canCreate || (base.disabled === true) !== acct.disabled;
    if (stale) throw apiError_('CONFLICT', 'This person’s access was changed somewhere else. Their current access has been reloaded; please review and save again.');

    // ---- diff ----
    var grants = [], revokes = [], roleChanges = [], adminGrants = 0, adminLosses = 0;
    ids.forEach(function (id) {
      var from = current[id], to = assign[id];
      if (from === to) return;
      if (from === 'none') { grants.push(id); if (to === 'admin') adminGrants++; }
      else if (to === 'none') { revokes.push(id); if (from === 'admin') adminLosses++; }
      else { roleChanges.push(id); if (to === 'admin') adminGrants++; else adminLosses++; }
    });
    var createChanged = wantCreate !== acct.canCreate;
    var disabledChanged = wantDisabled !== acct.disabled;
    var storeChanges = grants.concat(revokes, roleChanges);
    if (p.isNew === true && accessView_(actor).users.some(function (u) { return u.email === email; })) {
      throw apiError_('INVALID', email + ' is already a user. Select them from the list instead of adding again.');
    }

    // ---- final admin count decides whether "Allow New Store Creation" can be on ----
    var finalAdmin = 0;
    listStores_().forEach(function (s) {
      var role = Object.prototype.hasOwnProperty.call(assign, s.id) ? assign[s.id] : (function () { var m = findMember_(s, email); return m && m.status === 'active' ? m.role : 'none'; })();
      if (role === 'admin') finalAdmin++;
    });
    if (wantCreate && !acct.canCreate && finalAdmin === 0) throw apiError_('INVALID', 'Store creation can only be allowed for someone who is an Administrator of at least one store.');

    // ---- guard rails per store ----
    storeChanges.forEach(function (id) {
      var s = fresh[id], from = current[id], to = assign[id];
      if (from === 'admin' && to !== 'admin' && activeAdminCount_(s.members, email) === 0) {
        throw apiError_('INVALID', '“' + s.name + '” must keep at least one active administrator. Add another administrator there first.');
      }
      if (from === 'none' && (s.members || []).length >= MAX_MEMBERS_ && !findMember_(s, email)) {
        throw apiError_('INVALID', '“' + s.name + '” already has ' + MAX_MEMBERS_ + ' people. Remove someone first.');
      }
    });

    var needsConfirm = adminGrants > 0 || revokes.length > 0 || adminLosses > 0 || (createChanged && wantCreate) || (disabledChanged && wantDisabled);
    if (needsConfirm && p.confirm !== true) {
      throw apiError_('CONFIRM_REQUIRED', 'Please confirm these permission changes (' + grants.length + ' granted, ' + revokes.length + ' removed, ' + roleChanges.length + ' role changes).');
    }
    if (!storeChanges.length && !createChanged && !disabledChanged) {
      return { changed: false, access: accessView_(actor) };
    }

    // ---- apply: remember every raw record first so any failure restores the previous state ----
    var saved = {};
    var acctRaw = scriptProp_(acctKey_(email));
    var props = PropertiesService.getScriptProperties();
    var logs = [];
    var now = new Date().toISOString();
    var actorEmail = String(actor).toLowerCase();
    try {
      storeChanges.forEach(function (id) {
        var s = fresh[id], from = current[id], to = assign[id];
        saved[id] = scriptProp_('STORE_' + id);
        ensureBackup_(id);
        var m = findMember_(s, email);
        if (to === 'none') {
          s.members = s.members.filter(function (x) { return x.email !== email; });
        } else if (m) {
          m.role = to; m.status = 'active'; if (to !== 'admin') m.manager = false;
        } else {
          s.members.push({ email: email, role: to, manager: false, status: 'active', added: now, by: actorEmail });
        }
        saveStore_(s);
        logs.push([now, actorEmail, email, id, from, to]);
      });
      var finalCreate = wantCreate && finalAdmin > 0;
      if (createChanged || disabledChanged || !acct.exists || (acct.canCreate && !finalCreate)) saveAcct_(email, wantDisabled, finalCreate, actorEmail);
      if (!createChanged && acct.canCreate && !finalCreate) logs.push([now, actorEmail, email, '*create', 'on', 'off (no longer an administrator)']);
      if (createChanged) logs.push([now, actorEmail, email, '*create', acct.canCreate ? 'on' : 'off', wantCreate ? 'on' : 'off']);
      if (disabledChanged) logs.push([now, actorEmail, email, '*account', acct.disabled ? 'disabled' : 'enabled', wantDisabled ? 'disabled' : 'enabled']);
    } catch (err) {
      Object.keys(saved).forEach(function (id) { props.setProperty('STORE_' + id, saved[id]); });
      if (acctRaw) props.setProperty(acctKey_(email), acctRaw); else props.deleteProperty(acctKey_(email));
      console.error('saveUserAccess rolled back: ' + (err && err.stack ? err.stack : err));
      if (err && err.isApiError) throw err;
      throw apiError_('SERVER', 'The change could not be saved and nothing was changed. Please try again.');
    }
    storeChanges.forEach(function (id) { bumpRev_(id); });
    try { logPerm_(logs); } catch (e) { console.error('permission log failed: ' + e); }
    return { changed: true, summary: { granted: grants.length, revoked: revokes.length, roleChanged: roleChanges.length }, access: accessView_(actor) };
  });
}

/* ---------- owner-only editor helpers ---------- */

/** One-time, idempotent. Backs up every store record (first-seen copy only) and reports what exists. Changes no permission. */
function migrateV53() {
  assertOwnerCaller_();
  var stores = listStores_();
  var props = PropertiesService.getScriptProperties();
  var made = 0, existed = 0;
  stores.forEach(function (s) {
    if (scriptProp_(BAK53_PREFIX_ + s.id)) { existed++; return; }
    ensureBackup_(s.id); made++;
  });
  props.setProperty('PERM_SCHEMA', '5.3');
  var people = {};
  stores.forEach(function (s) { (s.members || []).forEach(function (m) { people[m.email] = 1; }); });
  return { stores: stores.length, backupsCreated: made, backupsAlreadyPresent: existed, uniqueUsers: Object.keys(people).length, accountSwitchesGranted: 0, schema: '5.3' };
}

/** Owner-only: the private permission-change log, newest last, times in Asia/Karachi. */
function showPermissionLog() {
  assertOwnerCaller_();
  var list = [];
  try { list = JSON.parse(scriptProp_(PERMLOG_KEY_) || '[]'); } catch (e) { list = []; }
  return list.map(function (e) {
    return { time: Utilities.formatDate(new Date(e[0]), DISPLAY_TZ_, 'dd MMM yyyy, hh:mm:ss a'), by: e[1], user: e[2], store: e[3], from: e[4], to: e[5] };
  });
}
