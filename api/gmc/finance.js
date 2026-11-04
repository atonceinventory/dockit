// GMC finance: one JSON feed for the Docket Finance tab.
//   - Income, expenses and invoices from the GMC finance Google Sheet (read via a service account)
//   - "Clips" = GMC's Stripe application fees from Solis memberships, pulled live from Stripe
// Members only: the request must carry a Firebase ID token from a Docket member.
//
// Env vars (Vercel, Docket project):
//   GMC_SHEET_ID        the finance spreadsheet id (defaults to the FY2026-27 sheet)
//   GMC_SHEETS_SA       service account JSON (raw or base64) that the sheet is shared with; falls back to SOLIS_FIREBASE_SA
//   SOLIS_STRIPE_SECRET_KEY / SOLIS_STRIPE_ACCOUNT   reused from the Solis membership setup (clips)
//   GMC_CLIPS_CLIENT    client name the clips belong to, default "Solis"

import crypto from 'node:crypto';
import { stripe } from '../solis/_lib.js';

const FIREBASE_PROJECT = 'docket-6159b';
const MEMBERS = ['griffgamble1@gmail.com', 'byhollyholiday@gmail.com', 'hello@gm-charlie.com'];
const DEFAULT_SHEET = '1-gOZPoenfZ1MqZdMtDGyBEoE_3n651xC-CTN1onmtdA';
const TABS = { invoices: 'Invoices', payments: 'Payments received', expenses: 'Expenses' };

export const config = { maxDuration: 30 };

// ---------- Firebase ID token check ----------

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

function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

// ---------- Google Sheets via service account ----------

function serviceAccount() {
  const raw = (process.env.GMC_SHEETS_SA || process.env.SOLIS_FIREBASE_SA || '').trim();
  if (!raw) return null;
  const json = raw.charAt(0) === '{' ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json);
}

let sheetsTok = null;
async function sheetsToken(sa) {
  if (sheetsTok && sheetsTok.exp > Date.now() + 60000) return sheetsTok.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = function (o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); };
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }).toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google token error: ' + (data.error_description || data.error || res.status));
  sheetsTok = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return sheetsTok.token;
}

async function readSheet(sheetId) {
  const sa = serviceAccount();
  if (!sa) throw new Error('No service account configured (GMC_SHEETS_SA)');
  const token = await sheetsToken(sa);
  const ranges = Object.keys(TABS).map(function (k) { return 'ranges=' + encodeURIComponent("'" + TABS[k] + "'!A1:Z2000"); }).join('&');
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values:batchGet?' + ranges + '&valueRenderOption=FORMATTED_VALUE', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await res.json();
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || ('Sheets HTTP ' + res.status));
    e.status = res.status; e.saEmail = sa.client_email;
    throw e;
  }
  const out = {};
  Object.keys(TABS).forEach(function (k, i) { out[k] = rows((data.valueRanges[i] && data.valueRanges[i].values) || []); });
  return out;
}

// header row -> array of objects keyed by a normalised header
function rows(values) {
  if (!values.length) return [];
  const head = values[0].map(norm);
  return values.slice(1).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); }).map(function (r) {
    const o = {};
    head.forEach(function (h, i) { if (h) o[h] = r[i] === undefined ? '' : String(r[i]).trim(); });
    return o;
  });
}
function norm(h) { return String(h || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function pick(o, names) { for (const n of names) { if (o[n] !== undefined && o[n] !== '') return o[n]; } return ''; }
function money(s) {
  if (s === undefined || s === null) return 0;
  const t = String(s).trim();
  if (!t || t === '-' || t === '–') return 0;
  const neg = /^\(.*\)$/.test(t) || /-/.test(t.replace(/^[^\d-]*/, '').charAt(0));
  const n = parseFloat(t.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : (neg ? -n : n);
}
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(s) {
  const t = String(s || '').trim();
  let m;
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,4})\.?\s+(\d{4})$/.exec(t))) { const mo = MON[m[2].toLowerCase()]; if (mo !== undefined) return new Date(Date.UTC(+m[3], mo, +m[1])); }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(Date.UTC(y, +m[2] - 1, +m[1])); }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(t);
  return isNaN(d) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
function monthKey(d) { return d ? d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') : ''; }
function typeOf(s) {
  const t = String(s || '').toLowerCase();
  if (/clip|stripe|passive/.test(t)) return 'clips';
  if (/blank|garment|merch|production/.test(t)) return 'blanks';
  return 'service';
}

// ---------- Stripe clips ----------

async function readClips(fyStart, fyEnd) {
  const fees = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const params = { limit: 100, 'created[gte]': Math.floor(fyStart / 1000), 'created[lt]': Math.floor(fyEnd / 1000) };
    if (after) params.starting_after = after;
    const data = await stripe('GET', '/application_fees', params);
    (data.data || []).forEach(function (f) {
      fees.push({ id: f.id, created: new Date(f.created * 1000).toISOString(), amount: (f.amount - (f.amount_refunded || 0)) / 100, currency: f.currency, charge: f.charge });
    });
    if (!data.has_more || !data.data.length) break;
    after = data.data[data.data.length - 1].id;
  }
  let activeMembers = null;
  try {
    const acct = process.env.SOLIS_STRIPE_ACCOUNT;
    if (acct) {
      let n = 0, sAfter = null;
      for (let page = 0; page < 10; page++) {
        const p = { status: 'active', limit: 100 };
        if (sAfter) p.starting_after = sAfter;
        const subs = await stripe('GET', '/subscriptions', p, { account: acct });
        n += (subs.data || []).length;
        if (!subs.has_more || !subs.data.length) break;
        sAfter = subs.data[subs.data.length - 1].id;
      }
      activeMembers = n;
    }
  } catch (e) { /* member count is a nicety */ }
  return { fees: fees, activeMembers: activeMembers };
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

  // Australian financial year: 1 Jul -> 30 Jun. ?fy=2026 means FY2026-27.
  const now = new Date();
  const curStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const fyYear = parseInt((req.query && req.query.fy) || curStart, 10) || curStart;
  const fyStart = Date.UTC(fyYear, 6, 1), fyEnd = Date.UTC(fyYear + 1, 6, 1);
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(fyYear, 6 + i, 1));
    months.push({ key: monthKey(d), label: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(2), service: 0, blanks: 0, clips: 0, expenses: 0 });
  }
  const mIdx = {}; months.forEach(function (m, i) { mIdx[m.key] = i; });
  const inFY = function (d) { return d && d.getTime() >= fyStart && d.getTime() < fyEnd; };

  const out = {
    ok: true,
    fy: { year: fyYear, label: 'FY' + fyYear + '-' + String(fyYear + 1).slice(2), start: new Date(fyStart).toISOString().slice(0, 10), end: new Date(fyEnd - 1).toISOString().slice(0, 10) },
    months: months, clients: [], invoices: [], payments: [], expenses: [],
    totals: { service: 0, blanks: 0, blanksCost: 0, blanksMargin: 0, clips: 0, income: 0, expenses: 0, net: 0, shareEach: 0, outstanding: 0, gstCollected: 0, gstPaid: 0, gstNet: 0 },
    sheet: { ok: false, url: 'https://docs.google.com/spreadsheets/d/' + (process.env.GMC_SHEET_ID || DEFAULT_SHEET) + '/edit' },
    stripe: { ok: false, fees: [], activeMembers: null, client: process.env.GMC_CLIPS_CLIENT || 'Solis' },
    updatedAt: now.toISOString()
  };
  const clients = {};
  const client = function (name) {
    const k = (name || 'Unassigned').trim() || 'Unassigned';
    return clients[k] || (clients[k] = { name: k, service: 0, blanks: 0, blanksCost: 0, blanksMargin: 0, clips: 0, total: 0, outstanding: 0 });
  };

  const [sheetRes, clipsRes] = await Promise.allSettled([
    readSheet(process.env.GMC_SHEET_ID || DEFAULT_SHEET),
    readClips(fyStart, fyEnd)
  ]);

  if (sheetRes.status === 'fulfilled') {
    const sh = sheetRes.value;
    out.sheet.ok = true;
    sh.payments.forEach(function (p) {
      const d = parseDate(pick(p, ['date received', 'date']));
      const type = typeOf(pick(p, ['type']) || pick(p, ['notes']));
      const ex = money(pick(p, ['amount ex gst', 'amount received ex gst']));
      const inc = money(pick(p, ['amount received inc gst', 'amount inc gst', 'total inc gst']));
      const gst = money(pick(p, ['gst']));
      const row = { date: d ? d.toISOString().slice(0, 10) : '', invoice: pick(p, ['invoice no', 'invoice']), client: pick(p, ['client']), type: type, exGst: ex, incGst: inc, gst: gst, notes: pick(p, ['notes']) };
      out.payments.push(row);
      if (!inFY(d)) return;
      const c = client(row.client);
      if (type === 'clips') { out.totals.clips += ex; c.clips += ex; }
      else if (type === 'blanks') { out.totals.blanks += ex; c.blanks += ex; }
      else { out.totals.service += ex; c.service += ex; }
      out.totals.gstCollected += gst;
      const mi = mIdx[monthKey(d)]; if (mi !== undefined) months[mi][type] += ex;
    });
    sh.expenses.forEach(function (e) {
      const d = parseDate(pick(e, ['date paid', 'date']));
      const ex = money(pick(e, ['amount ex gst']));
      const gst = money(pick(e, ['gst included', 'gst']));
      const cat = pick(e, ['category']);
      const row = { date: d ? d.toISOString().slice(0, 10) : '', supplier: pick(e, ['supplier']), description: pick(e, ['description']), category: cat, client: pick(e, ['client']), exGst: ex, incGst: money(pick(e, ['amount paid inc gst', 'amount inc gst'])), gst: gst };
      out.expenses.push(row);
      if (!inFY(d)) return;
      out.totals.expenses += ex;
      out.totals.gstPaid += gst;
      const mi = mIdx[monthKey(d)]; if (mi !== undefined) months[mi].expenses += ex;
      if (/production|material|blank|garment/i.test(cat)) { out.totals.blanksCost += ex; if (row.client) client(row.client).blanksCost += ex; }
    });
    sh.invoices.forEach(function (v) {
      const d = parseDate(pick(v, ['invoice date', 'date']));
      const row = { no: pick(v, ['invoice no', 'invoice']), date: d ? d.toISOString().slice(0, 10) : '', client: pick(v, ['client']), description: pick(v, ['description']), type: typeOf(pick(v, ['type']) || pick(v, ['description'])), total: money(pick(v, ['total inc gst'])), received: money(pick(v, ['received to date', 'received'])), outstanding: money(pick(v, ['outstanding'])), status: pick(v, ['status']) };
      out.invoices.push(row);
      if (row.outstanding > 0) { out.totals.outstanding += row.outstanding; client(row.client).outstanding += row.outstanding; }
    });
  } else {
    const e = sheetRes.reason || {};
    out.sheet.error = e.message || String(e);
    if (e.status === 403 || e.status === 404) out.sheet.saEmail = e.saEmail || null;
  }

  if (clipsRes.status === 'fulfilled') {
    out.stripe.ok = true;
    out.stripe.fees = clipsRes.value.fees;
    out.stripe.activeMembers = clipsRes.value.activeMembers;
    const c = client(out.stripe.client);
    clipsRes.value.fees.forEach(function (f) {
      out.totals.clips += f.amount; c.clips += f.amount;
      const mi = mIdx[monthKey(new Date(f.created))]; if (mi !== undefined) months[mi].clips += f.amount;
    });
  } else {
    out.stripe.error = (clipsRes.reason && clipsRes.reason.message) || String(clipsRes.reason);
  }

  const t = out.totals;
  t.blanksMargin = t.blanks - t.blanksCost;
  t.income = t.service + t.blanks + t.clips;
  t.net = t.income - t.expenses;
  t.shareEach = t.net / 2;
  t.gstNet = t.gstCollected - t.gstPaid;
  Object.keys(t).forEach(function (k) { t[k] = Math.round(t[k] * 100) / 100; });
  months.forEach(function (m) { ['service', 'blanks', 'clips', 'expenses'].forEach(function (k) { m[k] = Math.round(m[k] * 100) / 100; }); });
  out.clients = Object.keys(clients).map(function (k) {
    const c = clients[k];
    c.blanksMargin = c.blanks - c.blanksCost;
    c.total = c.service + c.blanks + c.clips;
    Object.keys(c).forEach(function (f) { if (typeof c[f] === 'number') c[f] = Math.round(c[f] * 100) / 100; });
    return c;
  }).sort(function (a, b) { return b.total - a.total; });

  res.status(200).json(out);
}
