/**
 * Code.gs — web app entry points and the single authorized API gateway.
 *
 * Every client call goes through api(token, request). The gateway independently:
 *   1. validates the request envelope and payload (whitelist, deny unknown fields)
 *   2. verifies the caller's identity (server-side)
 *   3. resolves the store from the server-side registry
 *   4. resolves the caller's role for THAT store (never from the client)
 *   5. checks the action is allowed for that role (deny by default)
 *   6. runs the operation, which re-validates the target record and data
 */

var ACTIONS_ = {
  getState:     { roles: ['admin', 'team'], fields: {} },
  getRevision:  { roles: ['admin', 'team'], fields: {} },
  setDone:      { roles: ['admin', 'team'], fields: { recordId: 'string', done: 'boolean' } },
  addListings:  { roles: ['admin'], fields: { urls: 'array' } },
  updateUrl:    { roles: ['admin'], fields: { recordId: 'string', url: 'string', expectedVersion: 'number', confirm: 'boolean?' } },
  saveNote:     { roles: ['admin'], fields: { recordId: 'string', note: 'string', expectedVersion: 'number' } },
  removeRecord: { roles: ['admin'], fields: { recordId: 'string', confirm: 'boolean?' } },
  // V5.2 administrator controls (every one re-checks role + store + record on the server).
  editListing:   { roles: ['admin'], fields: { recordId: 'string', url: 'string', note: 'string?', expectedVersion: 'number', confirm: 'boolean?', notesChoice: 'string?' } },
  deleteListing: { roles: ['admin'], fields: { recordId: 'string', listingId: 'string?', confirm: 'boolean?' } },
  deleteStore:   { roles: ['admin'], fields: { confirmName: 'string', confirm: 'boolean' } },
  saveSettings: { roles: ['admin'], fields: { name: 'string', etsyUrl: 'string?' } },
  // Team management: administrators AND the owner/access-manager permission (checked in dispatch_).
  listMembers:     { roles: ['admin'], perm: 'manageTeam', fields: {} },
  addMember:       { roles: ['admin'], perm: 'manageTeam', fields: { email: 'string', role: 'string', manager: 'boolean?' } },
  setMemberRole:   { roles: ['admin'], perm: 'manageTeam', fields: { email: 'string', role: 'string', manager: 'boolean?', confirm: 'boolean?' } },
  setMemberStatus: { roles: ['admin'], perm: 'manageTeam', fields: { email: 'string', status: 'string', confirm: 'boolean?' } },
  removeMember:    { roles: ['admin'], perm: 'manageTeam', fields: { email: 'string', confirm: 'boolean?' } },
  // Account-level actions: signed-in identity required, no store in the request.
  listMyStores: { global: true, fields: {} },
  createStore:  { global: true, perm: 'createStore', fields: { requestId: 'string', name: 'string', etsyUrl: 'string?', admins: 'array', team: 'array' } },
  // V5.3 centralized access management: owner only (checked in dispatch_ AND again inside the function).
  listAccess:     { global: true, perm: 'owner', fields: {} },
  saveUserAccess: { global: true, perm: 'owner', fields: { email: 'string', isNew: 'boolean?', assignments: 'object', base: 'object', canCreate: 'boolean', disabled: 'boolean', confirm: 'boolean?' } },
  signOut:      { global: true, fields: {} },
  // Pre-authentication login steps. They never return store data.
  startLogin:   { preauth: true, roles: [], fields: { challenge: 'string' } },
  redeemLogin:  { preauth: true, roles: [], fields: { pending: 'string', verifier: 'string' } }
};

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  var boot = {
    storeId: '',
    authMode: getAuthMode_(),
    loginEnabled: getAuthMode_() === 'SESSION' && oauthConfigured_(),
    pending: '',
    notice: ''
  };
  var storeId = typeof params.store === 'string' ? params.store : '';

  try {
    if (params.error) {
      boot.notice = 'Sign-in was cancelled. Please try again.';
    } else if (typeof params.code === 'string' && typeof params.state === 'string' && boot.loginEnabled) {
      var r = handleLoginCallback_(params.code, params.state);
      boot.pending = r.pending;
      boot.notice = r.notice;
      if (r.storeId) storeId = r.storeId;
    }
  } catch (err) {
    console.error('doGet auth error: ' + (err && err.message));
    boot.notice = 'Sign-in is not available right now.';
  }

  boot.storeId = isValidStoreId_(storeId) ? storeId : '';
  var t = HtmlService.createTemplateFromFile('Index');
  // Escape characters that could terminate the surrounding <script> block.
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return t.evaluate()
    .setTitle('Listing Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function api(token, req) {
  try {
    return dispatch_(token, req);
  } catch (err) {
    if (err && err.isApiError) return { ok: false, code: err.code, message: err.message };
    console.error('api error: ' + (err && err.stack ? err.stack : err));
    return { ok: false, code: 'SERVER', message: 'Something went wrong. Please try again.' };
  }
}

function dispatch_(token, req) {
  // 1. envelope
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw apiError_('INVALID', 'Malformed request.');
  var k;
  for (k in req) {
    if (k !== 'action' && k !== 'storeId' && k !== 'payload') throw apiError_('INVALID', 'Malformed request.');
  }
  if (typeof req.action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS_, req.action)) {
    throw apiError_('INVALID', 'Unknown action.');
  }
  var def = ACTIONS_[req.action];
  var problem = validatePayload_(def.fields, req.payload);
  if (problem) throw apiError_('INVALID', problem);

  // Pre-authentication login steps (no identity yet; they hand out no store data).
  if (def.preauth) {
    if (!isValidStoreId_(req.storeId)) throw apiError_('INVALID', 'Malformed request.');
    var pp = req.payload || {};
    if (req.action === 'startLogin') return { ok: true, data: { authUrl: startLogin_(req.storeId, pp.challenge) } };
    return { ok: true, data: { token: redeemLogin_(req.storeId, pp.pending, pp.verifier) } };
  }

  // 2. identity
  var email = resolveIdentity_(token);

  // 2b. account-level actions (no store involved)
  if (def.global) {
    if (req.storeId !== undefined && req.storeId !== '') throw apiError_('INVALID', 'Malformed request.');
    if (def.perm === 'owner' && !isOwner_(email)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
    if (def.perm === 'createStore' && !canCreateStores_(email)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
    var gp = req.payload || {};
    if (req.action === 'listMyStores') return { ok: true, data: { stores: storesFor_(email) } };
    if (req.action === 'signOut') { revokeSessions_(email); return { ok: true, data: {} }; }
    if (req.action === 'createStore') return { ok: true, data: createStore_(email, gp) };
    if (req.action === 'listAccess') return { ok: true, data: listAccess_(email) };
    if (req.action === 'saveUserAccess') return { ok: true, data: saveUserAccess_(email, gp) };
    throw apiError_('INVALID', 'Unknown action.');
  }

  // 3. store  (same generic message for "no such store" and "no access": no enumeration)
  var store = getStore_(req.storeId);
  var denied = 'Access denied for ' + email + '. Ask the store owner to add this Google account.';
  if (!store) throw apiError_('DENIED', denied);

  // 4. role
  var role = roleFor_(store, email);
  if (!role) throw apiError_('DENIED', denied);

  // 5. action permission
  if (def.roles.indexOf(role) === -1) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
  if (def.perm === 'manageTeam' && !canManageTeam_(store, email)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');
  if (def.perm === 'owner' && !isOwner_(email)) throw apiError_('FORBIDDEN', 'You do not have permission to do that.');

  var p = req.payload || {};
  var data;
  switch (req.action) {
    case 'getState':
      data = getState_(store, role, email);
      data.caps = capsFor_(store, email, role);
      data.stores = storesFor_(email);
      data.store.id = store.id;
      if (role === 'admin') data.memberCount = (store.members || []).length; // for the delete-store summary
      if (isOwner_(email)) data.sheetUrl = sheetUrlFor_(store); // never sent to anyone else
      if (role === 'admin' && store.etsyStoreUrl) data.etsyStoreUrl = store.etsyStoreUrl; // never sent to team members
      break;
    case 'getRevision':
      data = { rev: getRev_(store.id), name: store.name };
      break;
    case 'setDone':
      data = setDone_(store, role, p.recordId, p.done);
      break;
    case 'addListings':
      data = addListings_(store, role, email, p.urls);
      break;
    case 'updateUrl':
      data = updateUrl_(store, role, email, p.recordId, p.url, p.expectedVersion, p.confirm === true);
      break;
    case 'saveNote':
      data = saveNote_(store, p.recordId, p.note, p.expectedVersion);
      break;
    case 'removeRecord':
      data = removeRecord_(store, role, email, p.recordId, p.confirm === true);
      break;
    case 'editListing':
      data = editListing_(store, role, email, p);
      break;
    case 'deleteListing':
      data = removeRecord_(store, role, email, p.recordId, p.confirm === true, p.listingId);
      break;
    case 'deleteStore':
      data = deleteStore_(email, store, p);
      break;
    case 'saveSettings':
      data = saveStoreName_(store, p.name, p.etsyUrl);
      break;
    case 'listMembers':
      data = listMembers_(store, email);
      break;
    case 'addMember':
      data = addMember_(store, email, p.email, p.role, p.manager === true);
      break;
    case 'setMemberRole':
      data = setMemberRole_(store, email, p.email, p.role, p.manager, p.confirm === true);
      break;
    case 'setMemberStatus':
      data = setMemberStatus_(store, email, p.email, p.status, p.confirm === true);
      break;
    case 'removeMember':
      data = removeMember_(store, email, p.email, p.confirm === true);
      break;
    default:
      throw apiError_('INVALID', 'Unknown action.');
  }
  return { ok: true, data: data };
}
