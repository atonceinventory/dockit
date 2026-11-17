// GMC Signals: one JSON feed for the Docket Signals tab (gm-charlie.com traffic).
// Reads Vercel Web Analytics through the public Web Analytics API.
// Members only: the request must carry a Firebase ID token from a Docket member.
//
// Env vars (Vercel, Docket project):
//   VERCEL_ANALYTICS_TOKEN   Vercel access token that can read the gm-charlie.com project (falls back to VERCEL_TOKEN)
//   GMC_VERCEL_PROJECT_ID    projectId of the gm-charlie.com project (prj_...)
//   GMC_VERCEL_TEAM_ID       teamId (team_...) if the project lives in a team; omit for a personal account
//
// Query: ?range=7|30|90 (days, default 30). Compares against the equal-length period before it.
// Web Analytics only exposes page views and visitors, so those are the headline numbers.

import crypto from 'node:crypto';

const FIREBASE_PROJECT = 'docket-6159b';
const MEMBERS = ['griffgamble1@gmail.com', 'byhollyholiday@gmail.com', 'hello@gm-charlie.com'];
const API = 'https://api.vercel.com/v1/query/web-analytics';

export const config = { maxDuration: 30 };

// ---------- Firebase ID token check (same as Finance) ----------

let certCache = null;
async function firebaseCerts() {
  if (certCache && certCache.exp > Date.now()) return certCache.keys;
  const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  const keys = await res.json();
  const cc = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  certCache = { keys: keys, exp: Date.now() + (cc ? Number(cc[1]) : 3600) * 1000 };
  return keys;
}

function b64urlJson(s) { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function verifyMember(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok) throw httpErr(401, 'Sign in to Docket first');
  const parts = tok.split('.');
  if (parts.length !== 3) throw httpErr(401, 'Bad token');
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  const keys = await firebaseCerts();
  const pem = keys[header.kid];
  if (!pem || header.alg !== 'RS256') throw httpErr(401, 'Unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey(pem), Buffer.from(parts[2], 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  if (!ok) throw httpErr(401, 'Token signature invalid');
  if (claims.aud !== FIREBASE_PROJECT || claims.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT) throw httpErr(401, 'Token is for another app');
  if (!claims.exp || claims.exp < now) throw httpErr(401, 'Session expired, sign in again');
  const email = String(claims.email || '').toLowerCase().trim();
  if (MEMBERS.indexOf(email) === -1) throw httpErr(403, 'Not a Docket member');
  return email;
}

// ---------- Vercel Web Analytics ----------

function iso(d) { return d.toISOString().slice(0, 10); }

async function query(path, params) {
  const token = process.env.VERCEL_ANALYTICS_TOKEN || process.env.VERCEL_TOKEN;
  const qs = new URLSearchParams({ projectId: process.env.GMC_VERCEL_PROJECT_ID });
  if (process.env.GMC_VERCEL_TEAM_ID) qs.set('teamId', process.env.GMC_VERCEL_TEAM_ID);
  Object.keys(params || {}).forEach(function (k) { qs.set(k, String(params[k])); });
  const res = await fetch(API + '/' + path + '?' + qs.toString(), { headers: { Authorization: 'Bearer ' + token } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (json && json.error && (json.error.message || json.error)) || text.slice(0, 160) || ('HTTP ' + res.status);
    throw new Error('Vercel ' + res.status + ': ' + msg);
  }
  return json && json.data !== undefined ? json.data : json;
}

function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function rows(d) { return Array.isArray(d) ? d : (d && typeof d === 'object' ? [d] : []); }

// Aggregate total for a window. Falls back to summing the daily rows (visitors then over-count repeat visitors).
function totalsFrom(totalRows, dailyRows) {
  const t = rows(totalRows)[0];
  if (t && (t.pageviews !== undefined || t.visitors !== undefined)) return { pageviews: num(t.pageviews), visitors: num(t.visitors), approx: false };
  return {
    pageviews: dailyRows.reduce(function (a, r) { return a + num(r.pageviews); }, 0),
    visitors: dailyRows.reduce(function (a, r) { return a + num(r.visitors); }, 0),
    approx: true
  };
}

// Fill every day in the window so charts have no gaps.
function fillDays(since, days, dailyRows) {
  const byDay = {};
  dailyRows.forEach(function (r) { byDay[String(r.timestamp || r.day || '').slice(0, 10)] = r; });
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400000);
    const r = byDay[iso(d)] || {};
    out.push({ date: iso(d), pageviews: num(r.pageviews), visitors: num(r.visitors) });
  }
  return out;
}

function dim(list, key) {
  return rows(list).map(function (r) {
    return { name: String(r[key] === undefined || r[key] === null || r[key] === '' ? '(none)' : r[key]), pageviews: num(r.pageviews), visitors: num(r.visitors) };
  });
}

// ---------- handler ----------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await verifyMember(req);
  } catch (e) {
    res.status(e.status || 401).json({ ok: false, error: e.message });
    return;
  }

  const missing = [];
  if (!(process.env.VERCEL_ANALYTICS_TOKEN || process.env.VERCEL_TOKEN)) missing.push('VERCEL_ANALYTICS_TOKEN');
  if (!process.env.GMC_VERCEL_PROJECT_ID) missing.push('GMC_VERCEL_PROJECT_ID');
  if (missing.length) {
    res.status(200).json({ ok: true, configured: false, missing: missing });
    return;
  }

  const days = [7, 30, 90].indexOf(parseInt((req.query && req.query.range) || 30, 10)) === -1 ? 30 : parseInt(req.query.range, 10);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * 86400000);
  const prevUntil = new Date(since.getTime() - 86400000);
  const prevSince = new Date(prevUntil.getTime() - (days - 1) * 86400000);
  const cur = { since: iso(since), until: iso(today) };
  const prev = { since: iso(prevSince), until: iso(prevUntil) };

  try {
    const [curDaily, prevDaily, curTotal, prevTotal, pages, refs, countries, devices, events] = await Promise.allSettled([
      query('visits/aggregate', Object.assign({ by: 'day' }, cur)),
      query('visits/aggregate', Object.assign({ by: 'day' }, prev)),
      query('visits/aggregate', cur),
      query('visits/aggregate', prev),
      query('visits/aggregate', Object.assign({ by: 'requestPath', limit: 10 }, cur)),
      query('visits/aggregate', Object.assign({ by: 'referrerHostname', limit: 10 }, cur)),
      query('visits/aggregate', Object.assign({ by: 'country', limit: 8 }, cur)),
      query('visits/aggregate', Object.assign({ by: 'deviceType', limit: 5 }, cur)),
      query('events/aggregate', Object.assign({ by: 'eventName', limit: 10 }, cur))
    ]);

    // The daily query is the one we cannot do without: surface its error.
    if (curDaily.status === 'rejected') throw curDaily.reason;
    const val = function (p) { return p.status === 'fulfilled' ? p.value : null; };

    const curRows = fillDays(since, days, rows(val(curDaily)));
    const prevRows = fillDays(prevSince, days, rows(val(prevDaily)));
    const curT = totalsFrom(val(curTotal), curRows);
    const prevT = totalsFrom(val(prevTotal), prevRows);

    res.status(200).json({
      ok: true,
      configured: true,
      range: { days: days, since: cur.since, until: cur.until, prevSince: prev.since, prevUntil: prev.until },
      totals: { current: curT, previous: prevT },
      daily: { current: curRows, previous: prevRows },
      pages: dim(val(pages), 'requestPath'),
      referrers: dim(val(refs), 'referrerHostname'),
      countries: dim(val(countries), 'country'),
      devices: dim(val(devices), 'deviceType'),
      events: rows(val(events)).map(function (r) { return { name: String(r.eventName || '(unnamed)'), count: num(r.count), visitors: num(r.visitors) }; }),
      updatedAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
}
