/**
 * StoreDelete.gs — V5.2 administrator "Delete Store" and owner recovery.
 *
 * A deleted store is never destroyed:
 *   - its registration (Script Property STORE_<id>) is removed, which revokes every user's access
 *     and makes the old application URL answer "access denied";
 *   - its spreadsheet is moved to Google Drive TRASH (recoverable for 30 days), never deleted;
 *   - only the edit trigger that belongs to THAT spreadsheet is removed (frees one of the 20 slots);
 *   - a recovery copy of the registration is kept in DELSTORE_<id> / DELMETA_<id> so the owner can
 *     run restoreDeletedStore('<id>') while the sheet is still in Trash.
 *
 * Order of operations (each step can fail safely, see rollback_):
 *   preflight (nothing changed) -> recovery copy -> remove registration -> remove trigger -> Trash sheet.
 * If the trigger or the Trash step fails, the registration (and trigger) are put back, so a store is
 * never left half-deleted.
 *
 * Needs the Google Drive scope (appsscript.json). Until the owner authorizes it, the preflight
 * refuses with DRIVE_AUTH and NOTHING is changed.
 */

var DELSTORE_ = 'DELSTORE_';
var DELMETA_ = 'DELMETA_';

/** Triggers created for exactly this spreadsheet by installEditTrigger_. */
function storeTriggers_(spreadsheetId) {
  return ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'onSheetEdit' && t.getTriggerSourceId() === spreadsheetId;
  });
}

function deletedMeta_(storeId) {
  var raw = scriptProp_(DELMETA_ + storeId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function listDeletedMeta_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var out = [];
  for (var k in all) {
    if (k.indexOf(DELMETA_) === 0) {
      var m = deletedMeta_(k.slice(DELMETA_.length));
      if (m) out.push(m);
    }
  }
  return out;
}

/**
 * When the project is at the trigger limit, drop ONLY triggers that belong to spreadsheets of
 * deleted stores (left behind if a trigger removal ever failed). Registered stores and unrelated
 * triggers are never touched. Returns how many were removed.
 */
function reclaimDeletedStoreTriggers_() {
  var dead = {};
  listDeletedMeta_().forEach(function (m) { if (m.spreadsheetId) dead[m.spreadsheetId] = true; });
  var live = {};
  listStores_().forEach(function (s) { live[s.spreadsheetId] = true; });
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var src = t.getTriggerSourceId();
    if (t.getHandlerFunction() === 'onSheetEdit' && dead[src] && !live[src]) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function deleteStore_(actor, store, p) {
  if (p.confirm !== true) throw apiError_('INVALID', 'Please confirm the deletion.');
  // Independent of the gateway: only an administrator of THIS store (the owner counts as one everywhere).
  if (roleFor_(store, actor) !== 'admin') throw apiError_('FORBIDDEN', 'You do not have permission to do that.');

  return withLock_(function () {
    var fresh = getStore_(store.id);
    if (!fresh) throw apiError_('NOT_FOUND', 'This store has already been deleted.');
    if (String(p.confirmName) !== fresh.name) throw apiError_('INVALID', 'The name you typed does not match this store.');

    // ---- preflight: no state is changed until every check passes ----
    var ssId = fresh.spreadsheetId;
    var masterId = scriptProp_('MASTER_TEMPLATE_ID');
    if (!ssId || ssId === masterId) throw apiError_('FORBIDDEN', 'This store cannot be deleted.');
    var shared = listStores_().some(function (s) { return s.id !== fresh.id && s.spreadsheetId === ssId; });
    if (shared) throw apiError_('FORBIDDEN', 'This store cannot be deleted.');
    openStoreSheet_(fresh);                       // spreadsheet really belongs to this store (identity stamp)
    var file;
    try {
      file = DriveApp.getFileById(ssId);
      file.getName();
      if (file.isTrashed()) throw new Error('already trashed');
    } catch (e) {
      throw apiError_('DRIVE_AUTH', 'Google Drive access is not authorized for Listing Studio yet, or the sheet is not available. Nothing was deleted.');
    }
    var triggers = storeTriggers_(ssId);

    // ---- recovery copy FIRST ----
    var props = PropertiesService.getScriptProperties();
    var rawStore = scriptProp_('STORE_' + fresh.id);
    var meta = {
      id: fresh.id, name: fresh.name, spreadsheetId: ssId, deletedAt: new Date().toISOString(),
      deletedBy: actor, members: (fresh.members || []).length, trashed: false, triggersRemoved: 0
    };
    props.setProperty(DELSTORE_ + fresh.id, rawStore);
    props.setProperty(DELMETA_ + fresh.id, JSON.stringify(meta));

    function rollback_(reinstallTrigger) {
      try { props.setProperty('STORE_' + fresh.id, rawStore); } catch (e1) { console.error('rollback registration failed'); }
      if (reinstallTrigger) { try { installEditTrigger_(ssId); } catch (e2) { console.error('rollback trigger failed'); } }
      try { props.deleteProperty(DELSTORE_ + fresh.id); props.deleteProperty(DELMETA_ + fresh.id); } catch (e3) { /* keep copy */ }
    }

    // ---- revoke access + drop registration ----
    props.deleteProperty('STORE_' + fresh.id);

    // ---- remove only THIS store's trigger ----
    var removed = 0;
    try {
      triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); removed++; });
    } catch (e4) {
      rollback_(removed > 0);
      throw apiError_('SERVER', 'The store could not be deleted and was left unchanged. Please try again.');
    }

    // ---- Trash the spreadsheet (recoverable) ----
    try {
      file.setTrashed(true);
      if (!DriveApp.getFileById(ssId).isTrashed()) throw new Error('not trashed');
    } catch (e5) {
      rollback_(removed > 0);
      throw apiError_('SERVER', 'The store could not be deleted and was left unchanged. Please try again.');
    }

    meta.trashed = true; meta.triggersRemoved = removed;
    props.setProperty(DELMETA_ + fresh.id, JSON.stringify(meta));
    bumpRev_(fresh.id);
    var stores = storesFor_(actor);
    return { deleted: { id: fresh.id, name: fresh.name }, nextStoreId: stores.length ? stores[0].id : '', stores: stores };
  });
}

/* ---------------- owner recovery (run from the Apps Script editor; no UI) ---------------- */

/** Lists deleted stores that can still be restored. Owner only. */
function listDeletedStores() {
  assertOwnerCaller_();
  var rows = listDeletedMeta_().map(function (m) {
    return { id: m.id, name: m.name, deletedAt: m.deletedAt, deletedBy: m.deletedBy, spreadsheetId: m.spreadsheetId };
  });
  Logger.log(rows.length ? JSON.stringify(rows, null, 2) : 'No deleted stores.');
  return rows;
}

/**
 * Restores a deleted store while its spreadsheet is still in Google Drive Trash: takes the sheet out
 * of Trash, re-registers the store with its original id, members and link, and reinstalls its trigger.
 * Owner only. Safe to re-run; fails without changing anything if a check does not pass.
 */
function restoreDeletedStore(storeId) {
  assertOwnerCaller_();
  if (!isValidStoreId_(storeId)) throw new Error('Give the store id, for example restoreDeletedStore("7f8550c888b2").');
  return withLock_(function () {
    var meta = deletedMeta_(storeId);
    var raw = scriptProp_(DELSTORE_ + storeId);
    if (!meta || !raw) throw new Error('No recovery record for ' + storeId + '. Run listDeletedStores() to see what can be restored.');
    if (scriptProp_('STORE_' + storeId)) throw new Error('That store is already registered.');
    var rec = JSON.parse(raw);
    var ssId = rec.spreadsheetId;
    if (!ssId || ssId === scriptProp_('MASTER_TEMPLATE_ID')) throw new Error('Refusing: not a store spreadsheet.');
    if (listStores_().some(function (s) { return s.spreadsheetId === ssId; })) throw new Error('That spreadsheet belongs to another store.');
    reclaimDeletedStoreTriggers_();
    if (ScriptApp.getProjectTriggers().length >= MAX_TRIGGERS_) throw new Error('No free trigger slot (limit ' + MAX_TRIGGERS_ + '). Delete a store first.');

    var file = DriveApp.getFileById(ssId);              // throws if it was emptied from Trash
    var wasTrashed = file.isTrashed();
    if (wasTrashed) file.setTrashed(false);
    var ok = false;
    try {
      var ss = SpreadsheetApp.openById(ssId);
      var m = ss.getSheetByName(META_SHEET_);
      ok = !!m && String(m.getRange(1, 2).getValue()) === storeId && String(m.getRange(2, 2).getValue()) === ssId;
    } catch (e) { ok = false; }
    if (!ok) {
      if (wasTrashed) file.setTrashed(true);
      throw new Error('The spreadsheet does not match this store. Nothing was restored.');
    }
    PropertiesService.getScriptProperties().setProperty('STORE_' + storeId, raw);
    try { installEditTrigger_(ssId); } catch (e2) { Logger.log('Restored, but the sheet trigger could not be installed: ' + e2.message); }
    PropertiesService.getScriptProperties().deleteProperty(DELSTORE_ + storeId);
    PropertiesService.getScriptProperties().deleteProperty(DELMETA_ + storeId);
    bumpRev_(storeId);
    Logger.log('Restored "' + meta.name + '" (' + storeId + '). Its members have access again.');
    return { id: storeId, name: meta.name };
  });
}


/** Owner-only, run once from the editor: triggers the Google Drive consent screen that store deletion needs (moving a sheet to Trash). Changes nothing. */
function authorizeDriveAccess() {
  assertOwnerCaller_();
  DriveApp.getRootFolder().getId();
  return "Drive access authorized";
}
