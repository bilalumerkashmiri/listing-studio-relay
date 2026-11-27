/**
 * Team.gs — per-store access management (Manage Team).
 *
 * EVERYTHING here is private (trailing "_"): nothing in this file can be called from a browser
 * except through api() -> dispatch_(), which authenticates, resolves the store and the caller's
 * role, and checks the action's permission BEFORE any function below runs. Each function below
 * then re-checks the specific change against the caller (defence in depth), inside the script
 * lock, on a freshly read store record.
 *
 * Permission model
 *   owner            OWNER_EMAIL. Full control of every store. Can never be changed, disabled,
 *                    removed or demoted by anyone.
 *   access manager   an ACTIVE administrator of THIS store that the owner flagged "manager".
 *                    May add/disable/restore/remove team members and ordinary administrators
 *                    of this store. May NOT touch managers or the owner, nor grant the manager
 *                    flag (owner only).
 *   administrator    works with listings and renames the store. No access to Manage Team.
 *   team member      toggles "Images Done". Nothing else.
 *  Nobody can change their own access. A store always keeps at least one ACTIVE administrator.
 */

var MAX_MEMBERS_ = 40;
var EMAIL_MAX_LEN_ = 254;

function parseEmail_(raw) {
  if (typeof raw !== 'string') throw apiError_('INVALID', 'Please enter a Google email address.');
  var e = raw.trim().toLowerCase();
  if (!e) throw apiError_('INVALID', 'Please enter a Google email address.');
  if (e.length > EMAIL_MAX_LEN_ || !EMAIL_RE_.test(e) || /[\u0000-\u001f\u007f<>(),;:"\\]/.test(e)) {
    throw apiError_('INVALID', '“' + raw.trim().slice(0, 60) + '” is not a valid email address.');
  }
  return e;
}

function findMember_(store, email) {
  var ms = store.members || [];
  for (var i = 0; i < ms.length; i++) if (ms[i].email === email) return ms[i];
  return null;
}

/** Owner, or an ACTIVE administrator of this store flagged as access manager. */
function canManageTeam_(store, email) {
  var e = String(email || '').toLowerCase();
  if (!e) return false;
  if (isOwner_(e)) return true;
  if (isAccountDisabled_(e)) return false;
  var m = findMember_(store, e);
  return !!m && m.status === 'active' && m.role === 'admin' && m.manager === true;
}

function activeAdminCount_(members, exceptEmail) {
  return members.filter(function (m) {
    return m.role === 'admin' && m.status === 'active' && m.email !== exceptEmail;
  }).length;
}

/**
 * Why `actor` may not change `target` at all ('' = allowed to try). The single place that
 * decides "who may touch whom"; used by every write AND to decide which buttons the UI offers.
 */
function whyCannotChange_(store, actor, target) {
  if (!canManageTeam_(store, actor)) return 'You do not have permission to manage this team.';
  if (isOwner_(target.email)) return 'The system owner cannot be changed.';
  if (target.email === String(actor).toLowerCase()) return 'You cannot change your own access.';
  if (target.manager && !isOwner_(actor)) return 'Only the system owner can change an access manager.';
  return '';
}

function formatAdded_(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, DISPLAY_TZ_, 'dd MMM yyyy, hh:mm:ss a');
}

/** Only ever handed to the owner (the sheet itself is also private to the owner in Drive). */
function sheetUrlFor_(store) {
  return 'https://docs.google.com/spreadsheets/d/' + store.spreadsheetId + '/edit';
}

function appUrlFor_(storeId) {
  var u = scriptProp_('WEBAPP_URL');
  return u ? u + '?store=' + storeId : '';
}

/** The table the UI shows. The owner is always listed first and always locked. */
function memberView_(store, actor) {
  var me = String(actor).toLowerCase();
  var owner = scriptProp_('OWNER_EMAIL').toLowerCase();
  var rows = [];
  if (owner) {
    rows.push({ email: owner, role: 'admin', manager: true, status: 'active', added: '', owner: true, you: me === owner, locked: true, why: 'The system owner cannot be changed.' });
  }
  (store.members || []).forEach(function (m) {
    if (m.email === owner) return;
    var why = whyCannotChange_(store, me, m);
    rows.push({
      email: m.email, role: m.role, manager: m.manager, status: m.status, added: formatAdded_(m.added),
      owner: false, you: m.email === me, locked: !!why, why: why
    });
  });
  var out = {
    members: rows,
    count: (store.members || []).length,
    limit: MAX_MEMBERS_,
    appUrl: appUrlFor_(store.id),
    canGrantManager: isOwner_(me)
  };
  if (isOwner_(me)) out.sheetUrl = sheetUrlFor_(store);
  return out;
}

/** Runs `change(freshStore)` under the lock, saves, bumps the revision and returns the new table. */
function mutateMembers_(store, actor, change) {
  return withLock_(function () {
    var fresh = getStore_(store.id);
    if (!fresh) throw apiError_('DENIED', 'This store is not available.');
    if (!canManageTeam_(fresh, actor)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
    change(fresh);
    saveStore_(fresh);
    bumpRev_(fresh.id);
    return memberView_(getStore_(fresh.id), actor);
  });
}

function listMembers_(store, actor) {
  return memberView_(store, actor);
}

function addMember_(store, actor, rawEmail, role, manager) {
  var email = parseEmail_(rawEmail);
  if (role !== 'admin' && role !== 'team') throw apiError_('INVALID', 'Choose Administrator or Team Member.');
  if (manager === true && role !== 'admin') throw apiError_('INVALID', 'Only administrators can manage the team.');
  if (manager === true && !isOwner_(actor)) throw apiError_('FORBIDDEN', 'Only the system owner can make someone an access manager.');
  if (isOwner_(email)) throw apiError_('INVALID', 'That is the system owner account. It already has full access.');
  return mutateMembers_(store, actor, function (fresh) {
    if (findMember_(fresh, email)) {
      throw apiError_('INVALID', email + ' is already on this store' + (findMember_(fresh, email).status === 'disabled' ? ' (access disabled; use Restore).' : '.'));
    }
    if (fresh.members.length >= MAX_MEMBERS_) throw apiError_('INVALID', 'A store can have at most ' + MAX_MEMBERS_ + ' people. Remove someone first.');
    fresh.members.push({
      email: email, role: role, manager: role === 'admin' && manager === true, status: 'active',
      added: new Date().toISOString(), by: String(actor).toLowerCase()
    });
  });
}

function setMemberRole_(store, actor, rawEmail, role, manager, confirm) {
  var email = parseEmail_(rawEmail);
  if (isOwner_(email)) throw apiError_('FORBIDDEN', 'The system owner cannot be changed.');
  if (role !== 'admin' && role !== 'team') throw apiError_('INVALID', 'Choose Administrator or Team Member.');
  if (manager === true && role !== 'admin') throw apiError_('INVALID', 'Only administrators can manage the team.');
  return mutateMembers_(store, actor, function (fresh) {
    var t = findMember_(fresh, email);
    if (!t) throw apiError_('NOT_FOUND', 'That person is not on this store.');
    var why = whyCannotChange_(fresh, actor, t);
    if (why) throw apiError_('FORBIDDEN', why);
    var wantManager = role === 'admin' && (manager === undefined ? t.manager : manager === true);
    if (wantManager !== t.manager && !isOwner_(actor)) throw apiError_('FORBIDDEN', 'Only the system owner can change who manages the team.');
    if (role === t.role && wantManager === t.manager) return; // nothing to change
    if (t.role === 'admin' && role === 'team' && t.status === 'active' && activeAdminCount_(fresh.members, t.email) === 0) {
      throw apiError_('INVALID', 'A store must keep at least one active administrator. Add another administrator first.');
    }
    // Any change that grants or removes administrator rights needs an explicit confirmation.
    if (confirm !== true) throw apiError_('CONFIRM_REQUIRED', 'Please confirm this change to administrator permissions.');
    t.role = role;
    t.manager = wantManager;
  });
}

function setMemberStatus_(store, actor, rawEmail, status, confirm) {
  var email = parseEmail_(rawEmail);
  if (isOwner_(email)) throw apiError_('FORBIDDEN', 'The system owner cannot be changed.');
  if (status !== 'active' && status !== 'disabled') throw apiError_('INVALID', 'Unknown status.');
  return mutateMembers_(store, actor, function (fresh) {
    var t = findMember_(fresh, email);
    if (!t) throw apiError_('NOT_FOUND', 'That person is not on this store.');
    var why = whyCannotChange_(fresh, actor, t);
    if (why) throw apiError_('FORBIDDEN', why);
    if (t.status === status) return;
    if (status === 'disabled' && t.role === 'admin') {
      if (activeAdminCount_(fresh.members, t.email) === 0) {
        throw apiError_('INVALID', 'A store must keep at least one active administrator. Add another administrator first.');
      }
      if (confirm !== true) throw apiError_('CONFIRM_REQUIRED', 'Please confirm disabling this administrator.');
    }
    if (status === 'active' && t.role === 'admin' && confirm !== true) {
      throw apiError_('CONFIRM_REQUIRED', 'Please confirm restoring this administrator.');
    }
    t.status = status;
  });
}

function removeMember_(store, actor, rawEmail, confirm) {
  var email = parseEmail_(rawEmail);
  if (isOwner_(email)) throw apiError_('FORBIDDEN', 'The system owner cannot be changed.');
  return mutateMembers_(store, actor, function (fresh) {
    var t = findMember_(fresh, email);
    if (!t) throw apiError_('NOT_FOUND', 'That person is not on this store.');
    var why = whyCannotChange_(fresh, actor, t);
    if (why) throw apiError_('FORBIDDEN', why);
    if (t.role === 'admin' && t.status === 'active' && activeAdminCount_(fresh.members, t.email) === 0) {
      throw apiError_('INVALID', 'A store must keep at least one active administrator. Add another administrator first.');
    }
    if (confirm !== true) throw apiError_('CONFIRM_REQUIRED', 'Please confirm removing this person.');
    fresh.members = fresh.members.filter(function (m) { return m.email !== email; });
  });
}

/* ---------- stores the signed-in person may open (switcher) ---------- */

/** Only stores where this identity has an ACTIVE role. Nothing else about other stores leaks. */
function storesFor_(email) {
  var out = [];
  listStores_().forEach(function (s) {
    var role = roleFor_(s, email);
    if (role) out.push({ id: s.id, name: s.name, role: role });
  });
  out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : (a.id < b.id ? -1 : 1); });
  return out;
}

function capsFor_(store, email, role) {
  var owner = isOwner_(email);
  return {
    isOwner: owner,
    rename: role === 'admin',
    manageTeam: canManageTeam_(store, email),
    createStore: canCreateStores_(email),
    manageAccess: owner,
    deleteStore: role === 'admin',
    grantManager: owner
  };
}
