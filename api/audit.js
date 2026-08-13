// Dockit -> Store Audit. Runs everything from a single URL:
//   1) Google PageSpeed Insights (Lighthouse) performance + Core Web Vitals
//   2) Page fetch -> Shopify detection, theme, and third-party app fingerprints
//
// Optional env var for reliable PSI:  PAGESPEED_API_KEY
// Query params: url (required), strategy ("mobile" default | "desktop")

const APP_SIGNATURES = [
  { name: 'Klaviyo', cat: 'Email / SMS', pats: ['klaviyo'] },
  { name: 'Yotpo', cat: 'Reviews / Loyalty', pats: ['yotpo'] },
  { name: 'Judge.me', cat: 'Reviews', pats: ['judge.me', 'judgeme'] },
  { name: 'Loox', cat: 'Reviews', pats: ['loox.io', 'looxreviews'] },
  { name: 'Stamped', cat: 'Reviews', pats: ['stamped.io'] },
  { name: 'Okendo', cat: 'Reviews', pats: ['okendo'] },
  { name: 'Trustpilot', cat: 'Reviews', pats: ['trustpilot'] },
  { name: 'Recharge', cat: 'Subscriptions', pats: ['rechargecdn', 'rechargepayments', 'recharge.com'] },
  { name: 'Bold', cat: 'Subscriptions / Upsell', pats: ['boldapps', 'bold-subscriptions'] },
  { name: 'ReConvert', cat: 'Upsell / Post-purchase', pats: ['reconvert'] },
  { name: 'Rebuy', cat: 'Personalisation / Upsell', pats: ['rebuyengine', 'rebuy.com'] },
  { name: 'Zipify', cat: 'Pages / Upsell', pats: ['zipify'] },
  { name: 'Gorgias', cat: 'Support / Helpdesk', pats: ['gorgias'] },
  { name: 'Tidio', cat: 'Live chat', pats: ['tidio'] },
  { name: 'Zendesk', cat: 'Support', pats: ['zendesk', 'zdassets'] },
  { name: 'Attentive', cat: 'SMS', pats: ['attentive', 'attn.tv'] },
  { name: 'Postscript', cat: 'SMS', pats: ['postscript'] },
  { name: 'Privy', cat: 'Popups / Email', pats: ['privy'] },
  { name: 'Justuno', cat: 'Popups / CRO', pats: ['justuno'] },
  { name: 'OptinMonster', cat: 'Popups', pats: ['optinmonster'] },
  { name: 'Hotjar', cat: 'Heatmaps / Analytics', pats: ['hotjar'] },
  { name: 'Lucky Orange', cat: 'Heatmaps', pats: ['luckyorange'] },
  { name: 'Microsoft Clarity', cat: 'Heatmaps', pats: ['clarity.ms'] },
  { name: 'Google Analytics / GTM', cat: 'Analytics', pats: ['googletagmanager', 'google-analytics', 'gtag('] },
  { name: 'Meta Pixel', cat: 'Ads / Pixel', pats: ['connect.facebook.net', 'fbevents', 'fbq('] },
  { name: 'TikTok Pixel', cat: 'Ads', pats: ['analytics.tiktok', 'ttq.'] },
  { name: 'Pinterest Tag', cat: 'Ads', pats: ['pintrk', 's.pinimg.com'] },
  { name: 'Searchanise', cat: 'Search', pats: ['searchanise'] },
  { name: 'Algolia', cat: 'Search', pats: ['algolia'] },
  { name: 'Nosto', cat: 'Personalisation', pats: ['nosto'] },
  { name: 'LimeSpot', cat: 'Personalisation', pats: ['limespot'] },
  { name: 'Swym Wishlist', cat: 'Wishlist', pats: ['swym'] },
  { name: 'Smile.io', cat: 'Loyalty', pats: ['smile.io', 'smileui'] },
  { name: 'LoyaltyLion', cat: 'Loyalty', pats: ['loyaltylion'] },
  { name: 'UpCart', cat: 'Cart drawer', pats: ['upcart'] },
  { name: 'Shogun', cat: 'Page builder', pats: ['shogun'] },
  { name: 'PageFly', cat: 'Page builder', pats: ['pagefly'] },
  { name: 'GemPages', cat: 'Page builder', pats: ['gempages'] },
  { name: 'Tapcart', cat: 'Mobile app', pats: ['tapcart'] },
  { name: 'Afterpay', cat: 'BNPL', pats: ['afterpay'] },
  { name: 'Klarna', cat: 'BNPL', pats: ['klarna'] },
  { name: 'Affirm', cat: 'BNPL', pats: ['affirm'] },
  { name: 'Shopify Search & Discovery', cat: 'Search', pats: ['search-and-discovery'] }
];

async function fetchHtml(url) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 9000);
  try {
    var r = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DockitAudit/1.0; +https://personaldocket.com)' }
    });
    var headers = {};
    r.headers.forEach(function (v, k) { headers[k.toLowerCase()] = v; });
    var html = await r.text();
    return { html: html.slice(0, 600000), headers: headers };
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

function detectStack(page) {
  if (!page) return { fetched: false };
  var html = (page.html || ''); var low = html.toLowerCase(); var h = page.headers || {};
  var isShopify = low.indexOf('cdn.shopify.com') !== -1 || low.indexOf('myshopify.com') !== -1 ||
    low.indexOf('shopify.theme') !== -1 || low.indexOf('data-shopify') !== -1 ||
    (h['x-shopify-stage'] !== undefined) || (h['x-shopid'] !== undefined) ||
    (h['powered-by'] && /shopify/i.test(h['powered-by']));
  var theme = null;
  var m = html.match(/Shopify\.theme\s*=\s*(\{[^;]*\})/);
  if (m) { try { var t = JSON.parse(m[1]); theme = { name: t.name || null, role: t.role || null }; } catch (e) {} }
  var apps = [];
  APP_SIGNATURES.forEach(function (sig) {
    for (var i = 0; i < sig.pats.length; i++) { if (low.indexOf(sig.pats[i]) !== -1) { apps.push({ name: sig.name, cat: sig.cat }); break; } }
  });
  var seen = {}; apps = apps.filter(function (a) { if (seen[a.name]) return false; seen[a.name] = 1; return true; });
  return { fetched: true, isShopify: !!isShopify, theme: theme, apps: apps };
}

async function runPageSpeed(url, strategy, key) {
  var api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    + '?url=' + encodeURIComponent(url) + '&strategy=' + strategy + '&category=performance' + (key ? ('&key=' + key) : '');
  var r = await fetch(api); var data = await r.json();
  if (!r.ok || data.error) {
    var msg = (data.error && data.error.message) ? data.error.message : 'PageSpeed could not analyse that URL.';
    return { error: msg, needsSetup: /quota|rate|keyless|dailyLimit|userRateLimit/i.test(msg) };
  }
  var lh = data.lighthouseResult || {}; var audits = lh.audits || {};
  var score = (lh.categories && lh.categories.performance && typeof lh.categories.performance.score === 'number') ? Math.round(lh.categories.performance.score * 100) : null;
  function metric(id) { var a = audits[id] || {}; return { value: a.displayValue || '', ms: (typeof a.numericValue === 'number') ? a.numericValue : null, score: (typeof a.score === 'number') ? a.score : null }; }
  var lab = { fcp: metric('first-contentful-paint'), lcp: metric('largest-contentful-paint'), tbt: metric('total-blocking-time'), cls: metric('cumulative-layout-shift'), si: metric('speed-index'), tti: metric('interactive') };
  var field = null, le = data.loadingExperience;
  if (le && le.metrics) { function f(id) { var mm = le.metrics[id]; return mm ? { p: mm.percentile, cat: mm.category } : null; } field = { overall: le.overall_category || null, lcp: f('LARGEST_CONTENTFUL_PAINT_MS'), inp: f('INTERACTION_TO_NEXT_PAINT'), cls: f('CUMULATIVE_LAYOUT_SHIFT_SCORE'), fcp: f('FIRST_CONTENTFUL_PAINT_MS') }; }
  var opportunities = [];
  Object.keys(audits).forEach(function (k) { var a = audits[k]; if (a && a.details && a.details.type === 'opportunity' && a.details.overallSavingsMs > 30) { opportunities.push({ title: a.title || k, savingsMs: Math.round(a.details.overallSavingsMs), description: (a.description || '').replace(/\s*\[.*?\]\(.*?\)/g, '').trim() }); } });
  opportunities.sort(function (a, b) { return b.savingsMs - a.savingsMs; }); opportunities = opportunities.slice(0, 10);
  var diagnostics = [];
  ['uses-responsive-images', 'offscreen-images', 'render-blocking-resources', 'unused-css-rules', 'unused-javascript', 'uses-optimized-images', 'uses-text-compression', 'server-response-time', 'mainthread-work-breakdown', 'dom-size', 'third-party-summary', 'uses-long-cache-ttl'].forEach(function (id) { var a = audits[id]; if (a && typeof a.score === 'number' && a.score < 0.9) diagnostics.push({ title: a.title || id, value: a.displayValue || '', description: (a.description || '').replace(/\s*\[.*?\]\(.*?\)/g, '').trim() }); });
  return { score: score, lab: lab, field: field, opportunities: opportunities, diagnostics: diagnostics, finalUrl: lh.finalUrl || url };
}

export default async function handler(req, res) {
  var url = (req.query.url || '').toString().trim();
  var strategy = ((req.query.strategy || 'mobile').toString().toLowerCase() === 'desktop') ? 'desktop' : 'mobile';
  if (!url) { res.status(400).json({ error: 'Enter a URL to audit.' }); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch (e) { res.status(400).json({ error: 'That does not look like a valid URL.' }); return; }
  var key = process.env.PAGESPEED_API_KEY || '';
  try {
    var results = await Promise.allSettled([ runPageSpeed(url, strategy, key), fetchHtml(url) ]);
    var psi = (results[0].status === 'fulfilled') ? results[0].value : { error: 'Performance audit failed.' };
    var stack = detectStack(results[1].status === 'fulfilled' ? results[1].value : null);
    if (psi.error && !stack.fetched) { res.status(400).json({ error: psi.error, needsSetup: psi.needsSetup }); return; }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    res.status(200).json({
      url: url, finalUrl: (psi.finalUrl || url), strategy: strategy, fetchedAt: new Date().toISOString(),
      score: psi.score !== undefined ? psi.score : null, lab: psi.lab || null, field: psi.field || null,
      opportunities: psi.opportunities || [], diagnostics: psi.diagnostics || [],
      perfError: psi.error || null, perfNeedsSetup: psi.needsSetup || false, platform: stack
    });
  } catch (e) { res.status(500).json({ error: 'Audit failed. Try again shortly.' }); }
}
