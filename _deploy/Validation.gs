/**
 * Validation.gs — pure functions only (no Apps Script services), so they can be
 * unit-tested outside Google. Apps Script's V8 runtime has no WHATWG `URL` class,
 * so this is an explicit, strict parser: scheme -> authority -> host allow-list ->
 * path -> locale -> "listing" -> numeric id.
 */

var ALLOWED_HOSTS_ = ['etsy.com', 'www.etsy.com'];
var LISTING_ID_RE_ = /^[1-9][0-9]{4,14}$/;
var LOCALE_SEGMENT_RE_ = /^[a-z]{2}(?:-[a-z]{2})?$/i;
var MAX_URL_LENGTH_ = 2048;
var INVALID_URL_MESSAGE_ = 'Please enter a valid Etsy product listing link.';

/**
 * Parses an Etsy listing URL.
 * @param {*} raw
 * @return {{ok:true, listingId:string, canonicalUrl:string}|{ok:false, code:string}}
 */
function parseEtsyListingUrl_(raw) {
  function fail(code) { return { ok: false, code: code }; }
  if (raw === null || raw === undefined) return fail('EMPTY');
  var s = String(raw).trim();
  if (!s) return fail('EMPTY');
  if (s.length > MAX_URL_LENGTH_) return fail('TOO_LONG');
  // No internal whitespace, control characters or backslashes.
  if (/[\s\u0000-\u001f\u007f\\]/.test(s)) return fail('MALFORMED');

  var rest;
  var explicit = /^([a-z][a-z0-9+.\-]*):\/\//i.exec(s);
  if (explicit) {
    var scheme = explicit[1].toLowerCase();
    if (scheme !== 'https' && scheme !== 'http') return fail('SCHEME');
    rest = s.slice(explicit[0].length);
  } else if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) {
    // javascript:, data:, mailto:, file: ... never acceptable.
    return fail('SCHEME');
  } else {
    rest = s; // "www.etsy.com/listing/123..." pasted without a scheme
  }

  var cut = rest.search(/[\/?#]/);
  var authority = cut === -1 ? rest : rest.slice(0, cut);
  var tail = cut === -1 ? '' : rest.slice(cut);
  if (!authority) return fail('MALFORMED');
  if (authority.indexOf('@') !== -1) return fail('HOST'); // user-info trick: etsy.com@evil.com

  var hostMatch = /^([a-z0-9.\-]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!hostMatch) return fail('MALFORMED');
  var host = hostMatch[1].toLowerCase();
  var port = hostMatch[2];
  if (port !== undefined && port !== '443' && port !== '80') return fail('HOST');
  if (ALLOWED_HOSTS_.indexOf(host) === -1) return fail('HOST'); // exact match: rejects etsy.com.evil.com

  var path = tail.split(/[?#]/)[0];
  if (path.charAt(0) !== '/') return fail('NOT_LISTING');
  var segs = path.split('/').filter(function (x) { return x.length > 0; });
  if (segs.length && LOCALE_SEGMENT_RE_.test(segs[0])) segs.shift();
  if (!segs.length || segs[0].toLowerCase() !== 'listing') return fail('NOT_LISTING');
  if (segs.length < 2) return fail('BAD_ID');
  if (segs.length > 3) return fail('NOT_LISTING'); // listing / id / slug only
  if (!LISTING_ID_RE_.test(segs[1])) return fail('BAD_ID');

  return {
    ok: true,
    listingId: segs[1], // always a string; never converted to a number
    canonicalUrl: 'https://www.etsy.com/listing/' + segs[1]
  };
}

var SHOP_NAME_RE_ = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}$/;
var SHOP_URL_MESSAGE_ = 'Please enter a valid Etsy shop link, for example https://www.etsy.com/shop/YourStore';

/**
 * Optional original Etsy SHOP url (not a product listing, not the app link). Pure syntax check: it never
 * contacts Etsy and proves nothing about whether the shop exists or belongs to anyone.
 * Empty -> {ok:true,url:''} (the field is optional). Canonical form drops query/fragment/tracking.
 * @return {{ok:true,url:string}|{ok:false,message:string}}
 */
function parseEtsyShopUrl_(raw) {
  function bad(msg) { return { ok: false, message: msg || SHOP_URL_MESSAGE_ }; }
  if (raw === null || raw === undefined) return { ok: true, url: '' };
  if (typeof raw !== 'string') return bad();
  var s = raw.trim();
  if (!s) return { ok: true, url: '' };
  if (s.length > MAX_URL_LENGTH_) return bad();
  if (/[\s\u0000-\u001f\u007f\\]/.test(s)) return bad();
  var m = /^https:\/\/([^\/?#]*)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(s);
  if (!m) return bad('The Etsy shop link must start with https://');
  var authority = m[1];
  if (authority.indexOf('@') !== -1) return bad();           // credentials / etsy.com@evil.com
  var hm = /^([a-z0-9.\-]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!hm) return bad();
  var host = hm[1].toLowerCase();
  if (hm[2] !== undefined && hm[2] !== '443') return bad();   // only the default HTTPS port
  if (ALLOWED_HOSTS_.indexOf(host) === -1) return bad('Only etsy.com shop links are allowed.');
  var segs = m[2].split('/').filter(function (x) { return x.length > 0; });
  var locale = '';
  if (segs.length && LOCALE_SEGMENT_RE_.test(segs[0])) locale = segs.shift().toLowerCase() + '/';
  if (segs.length && segs[0].toLowerCase() === 'listing') return bad('That is a product listing link. Enter the link to the whole shop instead.');
  if (segs.length !== 2 || segs[0].toLowerCase() !== 'shop' || !SHOP_NAME_RE_.test(segs[1])) return bad();
  return { ok: true, url: 'https://www.etsy.com/' + locale + 'shop/' + segs[1] };
}

/** Store-name rules: trimmed, whitespace collapsed, 1-60 chars, no control chars. */
function normalizeStoreName_(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'Please enter a store name.' };
  var s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, message: 'Store name cannot be empty.' };
  if (s.length > 60) return { ok: false, message: 'Store name must be 60 characters or fewer.' };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, message: 'Store name contains invalid characters.' };
  return { ok: true, name: s };
}

/** Whitelist payload validation. spec: {field: 'string'|'number'|'boolean'|'array', optional via trailing '?'} */
function validatePayload_(spec, payload) {
  var p = payload === undefined || payload === null ? {} : payload;
  if (typeof p !== 'object' || Array.isArray(p)) return 'Malformed request.';
  var key;
  for (key in p) {
    if (Object.prototype.hasOwnProperty.call(p, key) && !Object.prototype.hasOwnProperty.call(spec, key)) {
      return 'Unexpected field in request.';
    }
  }
  for (key in spec) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) continue;
    var t = spec[key];
    var optional = t.charAt(t.length - 1) === '?';
    var type = optional ? t.slice(0, -1) : t;
    var v = p[key];
    if (v === undefined || v === null) {
      if (optional) continue;
      return 'Missing field in request.';
    }
    if (type === 'array') { if (!Array.isArray(v)) return 'Malformed request.'; }
    else if (type === 'object') { if (typeof v !== 'object' || Array.isArray(v)) return 'Malformed request.'; }
    else if (type === 'number') { if (typeof v !== 'number' || !isFinite(v)) return 'Malformed request.'; }
    else if (typeof v !== type) return 'Malformed request.';
  }
  return '';
}
