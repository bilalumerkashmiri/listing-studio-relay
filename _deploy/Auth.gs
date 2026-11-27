/**
 * Auth.gs — verified identity and authorization.
 *
 * Two identity mechanisms, selected by Script Property AUTH_MODE:
 *
 *  SESSION (default; works for personal Gmail AND Workspace accounts)
 *    The web app runs as the owner and is reachable by anyone, but every API call
 *    must carry a signed session token. A token is only minted after the server has
 *    exchanged a Google OAuth authorization code for an ID token and verified it
 *    (audience, issuer, expiry, email_verified). The signing key never leaves the
 *    server (Script Properties).
 *
 *  ACTIVE_USER (Google Workspace only)
 *    Deploy "Execute as: me", "Who has access: Anyone in <your domain>". Then
 *    Session.getActiveUser().getEmail() is populated by Google for same-domain
 *    users. If it comes back empty, access is denied (fail closed).
 *
 * Roles are NEVER taken from the client. They are looked up server-side per store.
 */

var SESSION_TTL_MS_ = 12 * 60 * 60 * 1000;
var STATE_TTL_MS_ = 12 * 60 * 60 * 1000; // sign-in link stays valid as long as a session can

function scriptProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function getAuthMode_() {
  var m = scriptProp_('AUTH_MODE');
  return m === 'ACTIVE_USER' ? 'ACTIVE_USER' : 'SESSION';
}

function apiError_(code, message) {
  var e = new Error(message);
  e.isApiError = true;
  e.code = code;
  return e;
}

/* ---------- signing helpers ---------- */

function b64urlEncode_(str) {
  return Utilities.base64EncodeWebSafe(str, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function b64urlDecode_(s) {
  var pad = s.length % 4 === 0 ? '' : new Array(5 - (s.length % 4)).join('=');
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s + pad)).getDataAsString('UTF-8');
}

function hmac_(data) {
  var key = scriptProp_('SIGNING_KEY');
  if (!key || key.length < 32) throw apiError_('SERVER', 'Server is not configured.');
  var bytes = Utilities.computeHmacSha256Signature(data, key);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function signPayload_(obj) {
  var body = b64urlEncode_(JSON.stringify(obj));
  return body + '.' + hmac_(body);
}

function verifySigned_(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  if (!safeEqual_(parts[1], hmac_(parts[0]))) return null;
  try {
    var obj = JSON.parse(b64urlDecode_(parts[0]));
    if (!obj || typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function createSessionToken_(email) {
  var now = Date.now();
  return signPayload_({ t: 'session', e: String(email).toLowerCase(), iat: now, exp: now + SESSION_TTL_MS_ });
}

/** Per-user "sessions issued before this moment are void" marker (set by Sign out). */
function nbfKey_(email) {
  return 'NBF_' + sha256hex_(String(email).toLowerCase()).slice(0, 24);
}

function sha256hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 255).toString(16)).slice(-2);
  return out;
}

/** Voids every session this person has (all browsers) that was issued before now. */
function revokeSessions_(email) {
  PropertiesService.getScriptProperties().setProperty(nbfKey_(email), String(Date.now()));
}

/* ---------- identity ---------- */

/** @return {string} verified lower-case email, or throws AUTH_REQUIRED */
function resolveIdentity_(token) {
  if (getAuthMode_() === 'ACTIVE_USER') {
    var email = '';
    try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
    if (!email) throw apiError_('AUTH_REQUIRED', 'Your Google identity could not be verified.');
    return String(email).toLowerCase();
  }
  var claims = verifySigned_(token);
  if (!claims || claims.t !== 'session' || !claims.e) {
    throw apiError_('AUTH_REQUIRED', 'Please sign in with Google.');
  }
  var who = String(claims.e).toLowerCase();
  var nbf = Number(scriptProp_(nbfKey_(who))) || 0;
  if (nbf && (Number(claims.iat) || 0) <= nbf) {
    throw apiError_('AUTH_REQUIRED', 'You were signed out. Please sign in again.');
  }
  return who;
}

/* ---------- Google OAuth (authorization-code flow, SESSION mode) ---------- */

function oauthConfigured_() {
  return !!(scriptProp_('OAUTH_CLIENT_ID') && scriptProp_('OAUTH_CLIENT_SECRET') && scriptProp_('WEBAPP_URL'));
}

/**
 * LOGIN FLOW (browser-bound, single-use, replay-safe):
 *  1. The browser makes a random secret ("verifier") and keeps it in its own storage. It sends
 *     only SHA-256(verifier) ("challenge") to startLogin.
 *  2. The server returns a Google URL whose signed `state` carries {store, nonce, challenge, exp}.
 *  3. Google redirects back with ?code&state. The server: verifies the state signature + expiry,
 *     marks the nonce USED (replay protection), exchanges the code, verifies the ID token, and
 *     parks the verified email in the server-side cache as a one-time "pending login" bound to
 *     the challenge. NO session is issued here.
 *  4. The page that Google returned to asks redeemLogin(pending, verifier). Only the browser that
 *     started step 1 holds the verifier, so a callback URL planted in someone else's browser
 *     (login CSRF / session fixation) cannot be redeemed. Pending records are single-use, expire
 *     in 5 minutes, and are destroyed on the first wrong verifier.
 */
var PENDING_TTL_S_ = 300;
var STATE_USED_TTL_S_ = 21600; // cache maximum (6h) >= state lifetime
var CHALLENGE_RE_ = /^[A-Za-z0-9_-]{43}$/;
var VERIFIER_RE_ = /^[A-Za-z0-9_-]{43,128}$/;
var PENDING_ID_RE_ = /^[a-f0-9]{64}$/;

/**
 * OAuth redirect address. Normally the web app URL itself. If OAUTH_REDIRECT_URI is set it is
 * used instead (a static relay page that drops Google's ?authuser= and forwards code+state back
 * to WEBAPP_URL, so people with several Google accounts open can sign in). Property-only: never
 * taken from a request.
 */
function redirectUri_() {
  var u = scriptProp_('OAUTH_REDIRECT_URI') || scriptProp_('WEBAPP_URL');
  // Defence in depth: these are owner-set properties, but never hand Google (or a browser) a
  // non-https address or one carrying credentials, a query string or a fragment.
  if (!/^https:\/\/[A-Za-z0-9.\-]+(?::443)?(?:\/[A-Za-z0-9._~\-\/]*)?$/.test(u)) {
    throw apiError_('AUTH_UNAVAILABLE', 'Sign-in is not configured.');
  }
  return u;
}

function sha256b64url_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function loginCache_() { return CacheService.getScriptCache(); }

/** @return {string} Google authorization URL, with a signed browser-bound state. */
function startLogin_(storeId, challenge) {
  if (getAuthMode_() !== 'SESSION' || !oauthConfigured_()) throw apiError_('AUTH_UNAVAILABLE', 'Sign-in is not configured.');
  if (!isValidStoreId_(storeId) || typeof challenge !== 'string' || !CHALLENGE_RE_.test(challenge)) {
    throw apiError_('INVALID', 'Malformed request.');
  }
  var state = signPayload_({ t: 'state', s: storeId, n: Utilities.getUuid(), c: challenge, exp: Date.now() + STATE_TTL_MS_ });
  var q = {
    client_id: scriptProp_('OAUTH_CLIENT_ID'),
    redirect_uri: redirectUri_(),
    response_type: 'code',
    scope: 'openid email',
    state: state,
    prompt: 'select_account'
  };
  var parts = [];
  for (var k in q) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + parts.join('&');
}

/** Handles Google's redirect. @return {{pending:string, storeId:string, notice:string}} */
function handleLoginCallback_(code, stateToken) {
  var out = { pending: '', storeId: '', notice: '' };
  var st = verifySigned_(stateToken);
  if (!st || st.t !== 'state' || !st.n || !CHALLENGE_RE_.test(String(st.c || '')) || !isValidStoreId_(String(st.s || ''))) {
    out.notice = 'That sign-in link has expired. Please sign in again.';
    return out;
  }
  out.storeId = st.s;
  var cache = loginCache_();
  if (cache.get('used_' + st.n)) {
    out.notice = 'That sign-in link was already used. Please sign in again.';
    return out;
  }
  cache.put('used_' + st.n, '1', STATE_USED_TTL_S_); // burn the state before doing anything else
  var email = exchangeCodeForEmail_(code);
  if (!email) {
    out.notice = 'Google sign-in could not be verified. Please try again.';
    return out;
  }
  var pid = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 64);
  cache.put('pend_' + pid, JSON.stringify({ e: email, c: st.c, s: st.s }), PENDING_TTL_S_);
  out.pending = pid;
  return out;
}

/** Exchanges a one-time pending login + the browser's verifier for a session token. */
function redeemLogin_(storeId, pending, verifier) {
  if (getAuthMode_() !== 'SESSION') throw apiError_('AUTH_UNAVAILABLE', 'Sign-in is not configured.');
  var fail = function () { return apiError_('AUTH_REQUIRED', 'Sign-in could not be completed. Please sign in again.'); };
  if (typeof pending !== 'string' || !PENDING_ID_RE_.test(pending) || typeof verifier !== 'string' || !VERIFIER_RE_.test(verifier)) throw fail();
  var cache = loginCache_();
  var raw = cache.get('pend_' + pending);
  cache.remove('pend_' + pending); // single use, whatever happens next
  if (!raw) throw fail();
  var rec;
  try { rec = JSON.parse(raw); } catch (e) { throw fail(); }
  if (!rec || rec.s !== storeId || !safeEqual_(String(rec.c), sha256b64url_(verifier))) throw fail();
  return createSessionToken_(rec.e);
}

/** Exchanges the code and verifies the ID token. @return {string|null} verified email */
function exchangeCodeForEmail_(code) {
  if (!oauthConfigured_() || typeof code !== 'string' || code.length > 2048) return null;
  var clientId = scriptProp_('OAUTH_CLIENT_ID');
  var tokenResp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    muteHttpExceptions: true,
    payload: {
      code: code,
      client_id: clientId,
      client_secret: scriptProp_('OAUTH_CLIENT_SECRET'),
      redirect_uri: redirectUri_(),
      grant_type: 'authorization_code'
    }
  });
  if (tokenResp.getResponseCode() !== 200) return null;
  var idToken = (JSON.parse(tokenResp.getContentText()) || {}).id_token;
  if (!idToken) return null;
  // Independent verification of the ID token by Google's tokeninfo endpoint.
  var infoResp = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (infoResp.getResponseCode() !== 200) return null;
  var c = JSON.parse(infoResp.getContentText());
  var issOk = c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com';
  var expOk = Number(c.exp) * 1000 > Date.now();
  if (c.aud !== clientId || !issOk || !expOk || String(c.email_verified) !== 'true' || !c.email) return null;
  return String(c.email).toLowerCase();
}

/* ---------- authorization ---------- */

function isOwner_(email) {
  var owner = scriptProp_('OWNER_EMAIL').toLowerCase();
  var e = String(email || '').toLowerCase();
  return !!owner && !!e && e === owner;
}

/** @return {'admin'|'team'|''}  (disabled members are absent from store.admins/team: denied) */
function roleFor_(store, email) {
  var e = String(email || '').toLowerCase();
  if (!e) return '';
  if (isOwner_(e)) return 'admin';
  if (isAccountDisabled_(e)) return '';   // V5.3 global switch: denied everywhere, assignments kept
  if ((store.admins || []).indexOf(e) !== -1) return 'admin';
  if ((store.team || []).indexOf(e) !== -1) return 'team';
  return '';
}
