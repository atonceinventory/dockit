// Solis membership: shared helpers (Stripe REST, webhook signature, Firestore REST).
// Files starting with _ are not deployed as Vercel functions.
// No npm dependencies: Docket has no package.json, so everything uses fetch + node:crypto.
//
// Env vars (Vercel, Docket project):
//   SOLIS_STRIPE_SECRET_KEY      GMC platform secret key (sk_test_... in sandbox, sk_live_... at go-live)
//   SOLIS_STRIPE_WEBHOOK_SECRET  whsec_... from the Connect webhook endpoint
//   SOLIS_STRIPE_ACCOUNT         Solis connected account id (acct_...)
//   SOLIS_PRICE_ID               $50 fortnightly price on the connected account (price_...)
//   SOLIS_FEE_PERCENT            GMC application fee, default 5
//   SOLIS_SUCCESS_URL            page members land on after paying (Squarespace welcome page)
//   SOLIS_CANCEL_URL             page members return to if they back out (Squarespace membership page)
//   SOLIS_FIREBASE_SA            service account JSON for the solis-membership Firebase project (raw JSON or base64)

import crypto from 'node:crypto';

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_VERSION = '2025-03-31.basil';

export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Missing env var ' + name);
  }
  return v;
}

// ---------- Stripe ----------

export function formEncode(obj, prefix, out) {
  out = out || [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (Array.isArray(v)) {
      v.forEach(function (item, i) {
        const ik = key + '[' + i + ']';
        if (item !== null && typeof item === 'object') formEncode(item, ik, out);
        else out.push(encodeURIComponent(ik) + '=' + encodeURIComponent(item));
      });
    } else if (typeof v === 'object') {
      formEncode(v, key, out);
    } else {
      out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    }
  }
  return out;
}

export async function stripe(method, path, params, opts) {
  opts = opts || {};
  const headers = {
    Authorization: 'Bearer ' + env('SOLIS_STRIPE_SECRET_KEY'),
    'Stripe-Version': STRIPE_VERSION
  };
  if (opts.account) headers['Stripe-Account'] = opts.account;
  let url = STRIPE_API + path;
  let body;
  const qs = params ? formEncode(params).join('&') : '';
  if (method === 'GET') {
    if (qs) url += '?' + qs;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = qs;
  }
  const res = await fetch(url, { method: method, headers: headers, body: body });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || ('Stripe HTTP ' + res.status));
    err.status = res.status;
    err.stripe = data && data.error;
    throw err;
  }
  return data;
}

// Verifies the Stripe-Signature header against the raw request body (Buffer).
export function verifyStripeSignature(rawBody, header, secret, toleranceSec) {
  toleranceSec = toleranceSec || 300;
  if (!header) throw new Error('Missing Stripe-Signature header');
  let t = null;
  const sigs = [];
  header.split(',').forEach(function (part) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  });
  if (!t || !sigs.length) throw new Error('Malformed Stripe-Signature header');
  const expected = crypto.createHmac('sha256', secret)
    .update(t + '.', 'utf8')
    .update(rawBody)
    .digest('hex');
  const exp = Buffer.from(expected, 'utf8');
  const ok = sigs.some(function (s) {
    const b = Buffer.from(s, 'utf8');
    return b.length === exp.length && crypto.timingSafeEqual(b, exp);
  });
  if (!ok) throw new Error('Signature mismatch');
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new Error('Signature timestamp too old');
  return true;
}

// Reads the raw body from the request stream. Do not touch req.body before calling this,
// Vercel parses it lazily and reading it consumes the stream.
export async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

// ---------- Firestore (solis-membership project) ----------

let saCache = null;
function serviceAccount() {
  if (saCache) return saCache;
  const raw = env('SOLIS_FIREBASE_SA').trim();
  const json = raw.charAt(0) === '{' ? raw : Buffer.from(raw, 'base64').toString('utf8');
  saCache = JSON.parse(json);
  return saCache;
}

let tokenCache = null;
async function googleToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const b64 = function (o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); };
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig
    }).toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google token error: ' + (data.error_description || data.error || res.status));
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function docUrl(path) {
  return 'https://firestore.googleapis.com/v1/projects/' + serviceAccount().project_id +
    '/databases/(default)/documents/' + path;
}

export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
}

export function toFields(obj) {
  const f = {};
  Object.keys(obj).forEach(function (k) { if (obj[k] !== undefined) f[k] = toValue(obj[k]); });
  return f;
}

export function fromValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}

export function fromFields(fields) {
  const o = {};
  Object.keys(fields || {}).forEach(function (k) { o[k] = fromValue(fields[k]); });
  return o;
}

// Merge fields into a document (creates it if missing). Only the given keys change.
export async function fsMerge(path, data) {
  const clean = {};
  Object.keys(data).forEach(function (k) { if (data[k] !== undefined) clean[k] = data[k]; });
  const mask = Object.keys(clean).map(function (k) {
    return 'updateMask.fieldPaths=' + encodeURIComponent(k);
  }).join('&');
  const res = await fetch(docUrl(path) + '?' + mask, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + (await googleToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(clean) })
  });
  if (!res.ok) throw new Error('Firestore write ' + path + ' failed: ' + res.status + ' ' + (await res.text()));
  return true;
}

export async function fsGet(path) {
  const res = await fetch(docUrl(path), {
    headers: { Authorization: 'Bearer ' + (await googleToken()) }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore read ' + path + ' failed: ' + res.status + ' ' + (await res.text()));
  const doc = await res.json();
  return fromFields(doc.fields);
}

// ---------- Small HTTP helpers ----------

export function redirect(res, url) {
  res.statusCode = 303;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

export function errorPage(res, status, message, backUrl) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const back = backUrl ? '<p><a href="' + backUrl + '">Go back</a></p>' : '';
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Solis</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">' +
    '<h1 style="font-size:1.25rem">Something went wrong</h1><p>' + message + '</p>' + back + '</body>');
}
