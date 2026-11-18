// GMC bot traffic + geo sessions for the Docket Signals tab.
// Reads the Microsoft Clarity Data Export API for the Clarity project the token belongs to.
// Members only: the request must carry a Firebase ID token from a Docket member.
//
// Env vars (Vercel, Docket project):
//   CLARITY_API_TOKEN   API token from Clarity > Settings > Data Export (project admin). Use the token for the gm-charlie.com project.
//
// Clarity limits: 10 requests per project per day, data only for the last 1-3 days, 1,000 rows, no pagination.
// So each refresh costs 1 request (by source; the response also carries the Country metric) and the result is cached in memory for 4 hours.

import crypto from 'node:crypto';

const FIREBASE_PROJECT = 'docket-6159b';
const MEMBERS = ['griffgamble1@gmail.com', 'byhollyholiday@gmail.com', 'hello@gm-charlie.com'];
const ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const TTL = 4 * 60 * 60 * 1000;
const DAYS = 3;

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

// ---------- Clarity ----------

function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }

async function clarity(dimension) {
  const qs = new URLSearchParams({ numOfDays: String(DAYS), dimension1: dimension });
  const res = await fetch(ENDPOINT + '?' + qs.toString(), {
    headers: { Authorization: 'Bearer ' + process.env.CLARITY_API_TOKEN, 'Content-Type': 'application/json' }
  });
  if (res.status === 401) throw new Error('Clarity rejected the token (401). Generate a new one in Clarity > Settings > Data Export.');
  if (res.status === 429) throw new Error('Clarity daily limit reached (10 requests per project per day). Try again tomorrow.');
  if (!res.ok) throw new Error('Clarity ' + res.status + ': ' + (await res.text()).slice(0, 160));
  return res.json();
}

const METRIC_KEYS = { totalsessioncount: 1, totalbotsessioncount: 1, distinctusercount: 1, distantusercount: 1, pagespersessionpercentage: 1 };

// Turn the "Traffic" metric rows into { name, sessions, bots, humans, users }.
function trafficRows(payload) {
  const list = Array.isArray(payload) ? payload : [];
  const traffic = list.find(function (m) { return m && String(m.metricName).toLowerCase() === 'traffic'; });
  const info = (traffic && Array.isArray(traffic.information)) ? traffic.information : [];
  return info.map(function (r) {
    const dimKey = Object.keys(r).find(function (k) { return !METRIC_KEYS[k.toLowerCase()]; });
    const humans = num(r.totalSessionCount), bots = num(r.totalBotSessionCount);
    return {
      name: dimKey ? String(r[dimKey] === null || r[dimKey] === '' ? '(none)' : r[dimKey]) : '(all)',
      sessions: humans + bots,
      bots: bots,
      humans: humans,
      users: num(r.distinctUserCount !== undefined ? r.distinctUserCount : r.distantUserCount)
    };
  });
}

function trafficOnly(raw) {
  const pick = function (p) { return (Array.isArray(p) ? p : []).filter(function (m) { return m && /traffic/i.test(String(m.metricName)); }); };
  const country = (Array.isArray(raw.sources) ? raw.sources : []).filter(function (m) { return m && String(m.metricName).toLowerCase() === 'country'; });
  return { sources: pick(raw.sources), country: country };
}

// Country metric: rows like { <country name>, sessionsCount, ... }. Field names are read defensively.
function countryRows(payload) {
  const list = Array.isArray(payload) ? payload : [];
  const m = list.find(function (x) { return x && String(x.metricName).toLowerCase() === 'country'; });
  const info = (m && Array.isArray(m.information)) ? m.information : [];
  return info.map(function (r) {
    const nameKey = Object.keys(r).find(function (k) { return typeof r[k] === 'string' && isNaN(Number(r[k])); });
    const humans = num(r.sessionsCount !== undefined ? r.sessionsCount : r.totalSessionCount);
    const bots = num(r.totalBotSessionCount !== undefined ? r.totalBotSessionCount : r.botSessionsCount);
    return { name: nameKey ? String(r[nameKey]) : '(unknown)', sessions: humans + bots, bots: bots, humans: humans, users: num(r.distinctUserCount) };
  });
}

let cache = null;

// ---------- handler ----------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await verifyMember(req);
  } catch (e) {
    res.status(e.status || 401).json({ ok: false, error: e.message });
    return;
  }
  if (!process.env.CLARITY_API_TOKEN) {
    res.status(200).json({ ok: true, configured: false, missing: ['CLARITY_API_TOKEN'] });
    return;
  }
  if (cache && cache.exp > Date.now()) {
    if (req.query && req.query.debug) { res.status(200).json({ ok: true, cachedRaw: JSON.stringify(trafficOnly(cache.raw)) }); return; }
    res.status(200).json(Object.assign({}, cache.body, { cached: true }));
    return;
  }
  try {
    // One request: the response carries every metric (Traffic split by Source, plus a Country metric).
    const srcRaw = await clarity('Source');
    const sources = trafficRows(srcRaw).sort(function (a, b) { return b.bots - a.bots; });
    const geo = countryRows(srcRaw).sort(function (a, b) { return b.sessions - a.sessions; });
    const sum = function (arr, k) { return arr.reduce(function (a, r) { return a + r[k]; }, 0); };
    // Clarity keeps bot sessions out of its session counts, so a source's total traffic is sessions + bots.
    const humans = sum(sources, 'sessions'), bots = sum(sources, 'bots'), sessions = humans + bots;
    const body = {
      ok: true,
      configured: true,
      windowDays: DAYS,
      totals: { sessions: sessions, bots: bots, humans: humans, botPct: sessions ? bots / sessions * 100 : 0 },
      geo: geo.slice(0, 15),
      sources: sources.slice(0, 15),
      updatedAt: new Date().toISOString(),
      cached: false
    };
    const raw = { sources: srcRaw };
    cache = { body: body, raw: raw, exp: Date.now() + TTL };
    if (req.query && req.query.debug) { res.status(200).json(Object.assign({}, body, { raw: JSON.stringify(trafficOnly(raw)) })); return; }
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
}
