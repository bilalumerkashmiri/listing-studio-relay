/**
 * Listings.gs — listing storage, validation workflow and completion logic.
 *
 * Sheet layout (sheet "Listings", row 1 = header):
 *   A Etsy Listing Link | B Listing ID | C Open Listing | D Notes | E Images Done
 *   F Date Added | G Date Completed                     <- visible daily workspace
 *   H Record ID | I Seq | J Status | K Reason | L Original Record ID | M Version | N Updated
 *                                                        <- hidden, protected internals
 *
 * Status: VALID | DUPLICATE | INVALID | ORPHAN
 * Identity of a record is its Record ID (UUID), never its row position.
 * Every mutation runs inside the script lock and re-checks duplicates inside it.
 */

var C_ = { URL: 0, ID: 1, OPEN: 2, NOTES: 3, DONE: 4, ADDED: 5, COMPLETED: 6, REC: 7, SEQ: 8, STATUS: 9, MSG: 10, ORIG: 11, VER: 12, UPD: 13 };
var NCOLS_ = 14;
var MAX_BATCH_ = 500;
var MAX_NOTE_ = 5000;
var DATE_FORMAT_ = 'dd MMM yyyy, hh:mm:ss a';

/* ===================== row <-> record ===================== */

function str_(v) { return v === null || v === undefined ? '' : String(v); }

function rowToRec_(v, row) {
  return {
    row: row,
    url: str_(v[C_.URL]).trim(),
    listingId: str_(v[C_.ID]).trim(),
    notes: str_(v[C_.NOTES]),
    done: v[C_.DONE] === true,
    added: v[C_.ADDED] instanceof Date ? v[C_.ADDED] : null,
    completed: v[C_.COMPLETED] instanceof Date ? v[C_.COMPLETED] : null,
    recordId: str_(v[C_.REC]),
    seq: Number(v[C_.SEQ]) || 0,
    status: str_(v[C_.STATUS]),
    msg: str_(v[C_.MSG]),
    origId: str_(v[C_.ORIG]),
    version: Number(v[C_.VER]) || 0,
    updated: v[C_.UPD] instanceof Date ? v[C_.UPD] : null
  };
}

function recToRow_(r) {
  var valid = r.status === 'VALID';
  return [
    r.url,
    r.listingId || '',
    valid ? '=HYPERLINK("https://www.etsy.com/listing/' + r.listingId + '","Open")' : '',
    valid ? r.notes : '',
    valid ? !!r.done : '',
    valid && r.added ? r.added : '',
    valid && r.done && r.completed ? r.completed : '',
    r.recordId,
    r.seq,
    r.status,
    r.msg || '',
    r.origId || '',
    r.version,
    r.updated || ''
  ];
}

function isBlankRec_(r) {
  return !r.url && !r.recordId && !r.listingId && !r.notes;
}

function needsAdoption_(r) {
  return (r.url && (!r.recordId || !r.status)) || (!r.url && r.recordId);
}

/* ===================== reading ===================== */

function readRecords_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, NCOLS_).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = rowToRec_(values[i], i + 2);
    if (!isBlankRec_(r)) out.push(r);
  }
  return out;
}

function findRowByRecordId_(sheet, recordId) {
  var last = sheet.getLastRow();
  if (last < 2 || !recordId) return 0;
  var ids = sheet.getRange(2, C_.REC + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === recordId) return i + 2;
  return 0;
}

/** Inside the lock: adopt rows typed/pasted directly in the sheet, then return all records. */
function loadForWrite_(store, sheet) {
  var recs = readRecords_(sheet);
  var targets = {};
  var any = false;
  recs.forEach(function (r) {
    if (needsAdoption_(r)) { targets[r.row] = { url: true }; any = true; }
  });
  if (any) {
    reconcileRows_(sheet, recs, targets);
    bumpRev_(store.id);
    recs = readRecords_(sheet);
  }
  return recs;
}

/* ===================== core entry evaluation ===================== */

function newCtx_(recs) {
  var max = 0;
  recs.forEach(function (r) { if (r.seq > max) max = r.seq; });
  return { now: new Date(), nextSeq: max + 1 };
}

/** listingId -> VALID record; the lowest persistent creation sequence wins. */
function buildIdMap_(recs) {
  var map = {};
  recs.slice().sort(function (a, b) { return a.seq - b.seq; }).forEach(function (r) {
    if (r.status === 'VALID' && r.listingId && !map[r.listingId]) map[r.listingId] = r;
  });
  return map;
}

/**
 * Decides what a (possibly changed) URL means for a row. `prev` is the record being
 * replaced (or null). Never mutates `prev`. Caller must add a VALID result to idMap.
 */
function applyEntry_(prev, rawUrl, idMap, ctx, keepNotes) {
  var url = String(rawUrl).trim().slice(0, MAX_URL_LENGTH_);
  var p = parseEtsyListingUrl_(url);
  var prevValid = !!prev && prev.status === 'VALID';
  var out = {
    row: prev ? prev.row : 0, url: url, listingId: '', notes: '', done: false, added: null, completed: null,
    recordId: '', seq: 0, status: '', msg: '', origId: '', version: 1, updated: ctx.now
  };

  if (p.ok) {
    out.listingId = p.listingId;
    var existing = idMap[p.listingId];
    if (existing && existing !== prev) {
      out.status = 'DUPLICATE';
      out.origId = existing.recordId;
    } else if (prevValid && prev.listingId === p.listingId) {
      // Same listing (different slug / tracking params / locale): keep ALL state.
      out.status = 'VALID';
      out.recordId = prev.recordId; out.seq = prev.seq; out.notes = prev.notes; out.done = prev.done;
      out.added = prev.added; out.completed = prev.completed;
      out.version = prev.version + (prev.url === url ? 0 : 1);
      return out;
    } else {
      out.status = 'VALID';
      out.added = ctx.now;
      if (keepNotes && prev) out.notes = prev.notes;
    }
  } else {
    out.status = 'INVALID';
    out.msg = p.code;
  }

  if (out.status !== 'VALID' && prev && !prevValid && prev.recordId) {
    out.recordId = prev.recordId; // error rows have no dependents; keep a stable id
    out.seq = prev.seq || ctx.nextSeq++;
  } else {
    out.recordId = Utilities.getUuid();
    out.seq = ctx.nextSeq++;
  }
  return out;
}

/** Records that pointed at `removedId` as their original can no longer silently inherit it. */
function orphanDependents_(recs, removedId, dirty) {
  recs.forEach(function (d) {
    if (d.status === 'DUPLICATE' && d.origId === removedId) {
      if (dirty[d.row] && dirty[d.row] !== d) return; // already re-evaluated this pass
      d.status = 'ORPHAN';
      d.origId = '';
      d.updated = new Date();
      dirty[d.row] = d;
    }
  });
}

/* ===================== writing ===================== */

function ensureRows_(sheet, lastNeeded) {
  var max = sheet.getMaxRows();
  if (lastNeeded > max) sheet.insertRowsAfter(max, lastNeeded - max + 50);
}

function groupContiguous_(recs) {
  var sorted = recs.slice().sort(function (a, b) { return a.row - b.row; });
  var groups = [];
  sorted.forEach(function (r) {
    var g = groups[groups.length - 1];
    if (g && g[g.length - 1].row + 1 === r.row) g.push(r); else groups.push([r]);
  });
  return groups;
}

/** Batched write: one setValues per contiguous block + one RangeList call per format. */
function writeRecords_(sheet, recs) {
  if (!recs.length) return;
  var validCells = [], otherCells = [];
  recs.forEach(function (r) { (r.status === 'VALID' ? validCells : otherCells).push('E' + r.row); });
  if (otherCells.length) sheet.getRangeList(otherCells).clearDataValidations();
  if (validCells.length) sheet.getRangeList(validCells).insertCheckboxes();
  groupContiguous_(recs).forEach(function (g) {
    // Defense in depth: rows added later may not inherit the template's plain-text format, so
    // set it explicitly BEFORE writing. Text cells can never be parsed as formulas.
    sheet.getRange(g[0].row, 1, g.length, 2).setNumberFormat('@');
    sheet.getRange(g[0].row, 4, g.length, 1).setNumberFormat('@');
    sheet.getRange(g[0].row, 12, g.length, 1).setNumberFormat('@');
    sheet.getRange(g[0].row, 1, g.length, NCOLS_).setValues(g.map(recToRow_));
  });
}

function blankRows_(sheet, rows) {
  groupContiguous_(rows.map(function (r) { return { row: r }; })).forEach(function (g) {
    var rng = sheet.getRange(g[0].row, 1, g.length, NCOLS_);
    rng.clearDataValidations();
    rng.clearContent();
  });
}

/* ===================== reconcile (direct sheet edits + adoption) ===================== */

/**
 * targets: { sheetRow: {url:bool, done:bool, notes:bool} }
 * Re-validates rows whose URL was typed/pasted directly in the sheet and keeps the
 * completion timestamp consistent with the checkbox. Idempotent.
 */
function reconcileRows_(sheet, recs, targets) {
  var ctx = newCtx_(recs);
  var idMap = {};
  var toEval = [];

  recs.forEach(function (r) {
    var t = targets[r.row];
    if (t && (t.url || !r.recordId || !r.status)) {
      var p = parseEtsyListingUrl_(r.url);
      var same = r.recordId && r.status === 'VALID' && p.ok && p.listingId === r.listingId;
      if (!same) { toEval.push(r); return; }
    }
  });
  var evalSet = {};
  toEval.forEach(function (r) { evalSet[r.row] = true; });
  var base = buildIdMap_(recs.filter(function (r) { return !evalSet[r.row]; }));
  for (var k in base) idMap[k] = base[k];

  var dirty = {};
  var blanks = [];
  toEval.sort(function (a, b) { return a.row - b.row; }).forEach(function (r) {
    var wasValidId = r.status === 'VALID' ? r.recordId : '';
    if (!r.url) {
      blanks.push(r.row);
      if (wasValidId) orphanDependents_(recs, wasValidId, dirty);
      return;
    }
    var out = applyEntry_(r, r.url, idMap, ctx, true);
    out.row = r.row;
    if (out.status === 'VALID') idMap[out.listingId] = out;
    dirty[r.row] = out;
    if (wasValidId && out.recordId !== wasValidId) orphanDependents_(recs, wasValidId, dirty);
  });

  recs.forEach(function (r) {
    var t = targets[r.row];
    if (!t || evalSet[r.row]) return;
    if (dirty[r.row] && dirty[r.row] !== r) return;
    if (t.done) {
      if (r.status === 'VALID') {
        if (r.done && !r.completed) { r.completed = ctx.now; r.updated = ctx.now; dirty[r.row] = r; }
        else if (!r.done && r.completed) { r.completed = null; r.updated = ctx.now; dirty[r.row] = r; }
      } else if (r.done) {
        r.done = false; dirty[r.row] = r;
      }
    }
    if (t.notes) {
      if (r.status === 'VALID') { r.version += 1; r.updated = ctx.now; }
      else r.notes = '';
      dirty[r.row] = r;
    }
  });

  var list = [];
  for (var row in dirty) list.push(dirty[row]);
  writeRecords_(sheet, list);
  if (blanks.length) blankRows_(sheet, blanks);
  return list.length + blanks.length > 0;
}

/* ===================== views ===================== */

function fmtDate_(d) {
  return d instanceof Date ? Utilities.formatDate(d, DISPLAY_TZ_, DATE_FORMAT_) : '';
}

function errorView_(r, byId) {
  if (r.status === 'DUPLICATE') {
    var orig = byId[r.origId];
    if (orig && orig.status === 'VALID') {
      return {
        kind: 'duplicate',
        heading: 'Duplicate Listing Detected!',
        message: 'Listing ID ' + r.listingId + ' already exists in row ' + (orig.row - 1) + '. This listing cannot be marked as Done.',
        originalId: orig.recordId,
        originalRow: orig.row - 1,
        originalDone: !!orig.done,
        originalState: orig.done ? 'Completed' : 'Remaining'
      };
    }
  }
  if (r.status === 'DUPLICATE' || r.status === 'ORPHAN') {
    return {
      kind: 'orphan',
      heading: 'Original Listing Removed',
      message: 'The original listing for ID ' + r.listingId + ' was removed or changed. Edit the link to validate this entry again, or clear it.'
    };
  }
  return { kind: 'invalid', heading: 'Invalid Listing URL!', message: INVALID_URL_MESSAGE_ };
}

function recView_(r, role, byId) {
  var valid = r.status === 'VALID';
  var admin = role === 'admin';
  return {
    id: r.recordId,
    n: r.row - 1,
    url: r.url,
    listingId: r.listingId,
    canonicalUrl: valid ? 'https://www.etsy.com/listing/' + r.listingId : '',
    notes: valid ? r.notes : '',
    done: valid && !!r.done,
    status: r.status,
    version: r.version,
    added: admin && valid ? fmtDate_(r.added) : '',
    addedDay: admin && valid && r.added ? Utilities.formatDate(r.added, DISPLAY_TZ_, 'yyyy-MM-dd') : '',   // Date Added filter (Asia/Karachi); admins only
    completed: admin && valid && r.done ? fmtDate_(r.completed) : '',
    error: valid ? null : errorView_(r, byId)
  };
}

function buildState_(store, role, email, recs, rev) {
  var byId = {};
  recs.forEach(function (r) { byId[r.recordId] = r; });
  var counts = { total: 0, completed: 0, remaining: 0, errors: 0 };
  var records = [];
  recs.slice().sort(function (a, b) { return a.row - b.row; }).forEach(function (r) {
    var valid = r.status === 'VALID';
    if (valid) { counts.total++; if (r.done) counts.completed++; else counts.remaining++; }
    else counts.errors++;
    if (role !== 'admin' && !valid) return; // team members never receive error records
    records.push(recView_(r, role, byId));
  });
  if (role !== 'admin') delete counts.errors;
  return {
    store: { name: store.name },
    role: role,
    email: email,
    rev: rev,
    counts: counts,
    records: records
  };
}

/* ===================== operations ===================== */

function getState_(store, role, email) {
  var rev = getRev_(store.id);
  var h = openStoreSheet_(store);
  var recs = readRecords_(h.sheet);
  if (recs.some(needsAdoption_)) {
    recs = withLock_(function () { return loadForWrite_(store, h.sheet); });
    rev = getRev_(store.id);
  }
  return buildState_(store, role, email, recs, rev);
}

function addListings_(store, role, email, urls) {
  if (urls.length > MAX_BATCH_) throw apiError_('INVALID', 'Please add at most ' + MAX_BATCH_ + ' links at a time.');
  var cleaned = [];
  for (var i = 0; i < urls.length; i++) {
    if (typeof urls[i] !== 'string') throw apiError_('INVALID', 'Malformed request.');
    var t = urls[i].trim();
    if (t) cleaned.push(t);
  }
  if (!cleaned.length) throw apiError_('INVALID', 'Paste at least one Etsy listing link.');

  return withLock_(function () {
    var h = openStoreSheet_(store);
    var recs = loadForWrite_(store, h.sheet);
    var ctx = newCtx_(recs);
    var idMap = buildIdMap_(recs); // authoritative duplicate check, INSIDE the lock
    var last = h.sheet.getLastRow();
    var start = last < 2 ? 2 : last + 1;
    var added = [];
    var results = [];
    cleaned.forEach(function (u, idx) {
      var out = applyEntry_(null, u, idMap, ctx, false);
      out.row = start + idx;
      if (out.status === 'VALID') idMap[out.listingId] = out;
      added.push(out);
      results.push({ id: out.recordId, status: out.status, listingId: out.listingId });
    });
    ensureRows_(h.sheet, start + added.length - 1);
    writeRecords_(h.sheet, added);
    var rev = bumpRev_(store.id);
    return { results: results, state: buildState_(store, role, email, recs.concat(added), rev) };
  });
}

function setDone_(store, role, recordId, done) {
  return withLock_(function () {
    var h = openStoreSheet_(store);
    var row = findRowByRecordId_(h.sheet, recordId);
    if (!row) throw apiError_('NOT_FOUND', 'This listing no longer exists. Refreshing…');
    var rec = rowToRec_(h.sheet.getRange(row, 1, 1, NCOLS_).getValues()[0], row);
    if (rec.status !== 'VALID') {
      throw apiError_('NOT_ALLOWED', 'This listing has an error and cannot be marked as done.');
    }
    if (rec.done === done) { // identical repeated request: nothing changes, timestamp preserved
      return { record: recView_(rec, role, {}), rev: getRev_(store.id), changed: false };
    }
    var now = new Date();
    h.sheet.getRange(row, C_.DONE + 1).setValue(done);
    h.sheet.getRange(row, C_.COMPLETED + 1).setValue(done ? now : '');
    h.sheet.getRange(row, C_.UPD + 1).setValue(now);
    rec.done = done;
    rec.completed = done ? now : null;
    var rev = bumpRev_(store.id);
    return { record: recView_(rec, role, {}), rev: rev, changed: true };
  });
}

function updateUrl_(store, role, email, recordId, url, expectedVersion, confirm) {
  if (!String(url).trim()) throw apiError_('INVALID', 'Enter a link, or use Clear to remove this entry.');
  return withLock_(function () {
    var h = openStoreSheet_(store);
    var recs = loadForWrite_(store, h.sheet);
    var rec = null;
    recs.forEach(function (r) { if (r.recordId === recordId) rec = r; });
    if (!rec) throw apiError_('NOT_FOUND', 'This entry no longer exists. Refreshing…');
    if (rec.version !== expectedVersion) {
      throw apiError_('CONFLICT', 'This listing was changed by someone else. The latest version has been loaded.');
    }
    var ctx = newCtx_(recs);
    var idMap = buildIdMap_(recs);
    var out = applyEntry_(rec, url, idMap, ctx, false);
    var identityChanged = rec.status === 'VALID' && out.recordId !== rec.recordId;
    if (identityChanged && (rec.notes || rec.done) && !confirm) {
      throw apiError_('CONFIRM_REQUIRED',
        'Changing to a different listing will discard this listing\'s notes and completion status.');
    }
    out.row = rec.row;
    var dirty = {};
    dirty[rec.row] = out;
    if (identityChanged) orphanDependents_(recs, rec.recordId, dirty);
    var list = [];
    for (var k in dirty) list.push(dirty[k]);
    writeRecords_(h.sheet, list);
    var rev = bumpRev_(store.id);
    var all = recs.map(function (r) { return r.row === out.row ? out : r; });
    return { state: buildState_(store, role, email, all, rev), focusId: out.recordId };
  });
}

function saveNote_(store, recordId, note, expectedVersion) {
  if (note.length > MAX_NOTE_) throw apiError_('INVALID', 'Notes can be at most ' + MAX_NOTE_ + ' characters.');
  var clean = note.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return withLock_(function () {
    var h = openStoreSheet_(store);
    var row = findRowByRecordId_(h.sheet, recordId);
    if (!row) throw apiError_('NOT_FOUND', 'This listing no longer exists. Refreshing…');
    var rec = rowToRec_(h.sheet.getRange(row, 1, 1, NCOLS_).getValues()[0], row);
    if (rec.status !== 'VALID') throw apiError_('NOT_ALLOWED', 'Notes can only be added to valid listings.');
    if (rec.version !== expectedVersion) {
      throw apiError_('CONFLICT', 'This note was changed by someone else. The latest version has been loaded.');
    }
    var now = new Date();
    h.sheet.getRange(row, C_.NOTES + 1).setNumberFormat('@').setValue(clean);
    h.sheet.getRange(row, C_.VER + 1, 1, 2).setValues([[rec.version + 1, now]]);
    rec.notes = clean; rec.version += 1;
    var rev = bumpRev_(store.id);
    return { record: recView_(rec, 'admin', {}), rev: rev };
  });
}

function removeRecord_(store, role, email, recordId, confirm, expectedListingId) {
  return withLock_(function () {
    var h = openStoreSheet_(store);
    var recs = loadForWrite_(store, h.sheet);
    var rec = null;
    recs.forEach(function (r) { if (r.recordId === recordId) rec = r; });
    // A repeated request (double click, retry) finds nothing and deletes nothing.
    if (!rec) throw apiError_('NOT_FOUND', 'This entry no longer exists. Refreshing…');
    // Stale screen guard: the record id is the identity; the listing id must still match too.
    if (expectedListingId && rec.listingId !== expectedListingId) {
      throw apiError_('CONFLICT', 'This listing was changed by someone else. The latest version has been loaded.');
    }
    if (rec.status === 'VALID' && !confirm) {
      throw apiError_('CONFIRM_REQUIRED', 'Removing this listing permanently deletes its notes and completion status.');
    }
    var dirty = {};
    if (rec.status === 'VALID') orphanDependents_(recs, rec.recordId, dirty);
    var list = [];
    for (var k in dirty) list.push(dirty[k]);
    writeRecords_(h.sheet, list);
    h.sheet.deleteRow(rec.row);
    var remaining = recs.filter(function (r) { return r !== rec; });
    remaining.forEach(function (r) { if (r.row > rec.row) r.row -= 1; });
    var rev = bumpRev_(store.id);
    return { state: buildState_(store, role, email, remaining, rev), deleted: { id: rec.recordId, listingId: rec.listingId } };
  });
}

/**
 * V5.2 — administrator "Edit Listing" dialog: link + notes in ONE locked operation.
 * Unlike updateUrl_, an invalid or duplicate replacement is REFUSED (never written), so a good
 * record can never be overwritten by an error state. The Listing ID is always derived from
 * the link; the client cannot supply one.
 *   same Listing ID (slug / tracking / locale changed): Date Added, Date Completed, completion
 *     and record identity are all preserved; notes change only if explicitly edited.
 *   different Listing ID: needs confirm:true; completion OFF, new Date Added, no Date Completed;
 *     notes kept or cleared according to notesChoice ('retain' | 'clear').
 */
function editListing_(store, role, email, p) {
  var rawUrl = String(p.url || '').trim();
  if (!rawUrl) throw apiError_('INVALID', 'Enter an Etsy listing link.');
  var hasNote = typeof p.note === 'string';
  if (hasNote && p.note.length > MAX_NOTE_) throw apiError_('INVALID', 'Notes can be at most ' + MAX_NOTE_ + ' characters.');
  var note = hasNote ? p.note.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : null;
  var choice = p.notesChoice;
  if (choice !== undefined && choice !== 'retain' && choice !== 'clear') throw apiError_('INVALID', 'Malformed request.');

  return withLock_(function () {
    var h = openStoreSheet_(store);
    var recs = loadForWrite_(store, h.sheet);
    var rec = null;
    recs.forEach(function (r) { if (r.recordId === p.recordId) rec = r; });
    if (!rec) throw apiError_('NOT_FOUND', 'This entry no longer exists. Refreshing…');
    if (rec.version !== p.expectedVersion) {
      throw apiError_('CONFLICT', 'This listing was changed by someone else. The latest version has been loaded.');
    }
    var parsed = parseEtsyListingUrl_(rawUrl.slice(0, MAX_URL_LENGTH_));
    if (!parsed.ok) throw apiError_('INVALID', INVALID_URL_MESSAGE_);

    var idMap = buildIdMap_(recs);
    var holder = idMap[parsed.listingId];
    if (holder && holder !== rec) {
      throw apiError_('DUPLICATE', 'Listing ID ' + parsed.listingId + ' already exists in row ' + (holder.row - 1) + '. Duplicate listings cannot be saved.');
    }

    var ctx = newCtx_(recs);
    var prevValid = rec.status === 'VALID';
    var out, dirty = {};

    if (prevValid && rec.listingId === parsed.listingId) {
      var url = rawUrl.slice(0, MAX_URL_LENGTH_);
      var newNotes = hasNote ? note : rec.notes;
      if (url === rec.url && newNotes === rec.notes) {
        return { state: buildState_(store, role, email, recs, getRev_(store.id)), focusId: rec.recordId, changed: false, identityChanged: false };
      }
      out = Object.assign({}, rec, { url: url, notes: newNotes, version: rec.version + 1, updated: ctx.now });
    } else {
      if (prevValid && p.confirm !== true) {
        throw apiError_('CONFIRM_REQUIRED', 'This changes the listing from ID ' + rec.listingId + ' to ID ' + parsed.listingId + '.');
      }
      var keepable = hasNote ? note : (prevValid ? rec.notes : '');
      if (prevValid && keepable && !choice) throw apiError_('INVALID', 'Choose whether to keep or clear the existing notes.');
      out = applyEntry_(rec, rawUrl, idMap, ctx, false);   // VALID: new identity, new Date Added, not done
      out.row = rec.row;
      out.notes = choice === 'clear' ? '' : keepable;
      if (prevValid) orphanDependents_(recs, rec.recordId, dirty);
    }
    dirty[rec.row] = out;
    var list = [];
    for (var k in dirty) list.push(dirty[k]);
    writeRecords_(h.sheet, list);
    var rev = bumpRev_(store.id);
    var all = recs.map(function (r) { return dirty[r.row] || r; });
    return { state: buildState_(store, role, email, all, rev), focusId: out.recordId, changed: true, identityChanged: out.recordId !== rec.recordId };
  });
}
