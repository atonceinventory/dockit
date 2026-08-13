// Docket -> AI audit insights. Takes the collected audit data and asks Claude
// to write an internal, actionable analysis for the GMC team to work from.
//
// Requires env var:  ANTHROPIC_API_KEY  (console.anthropic.com > API keys)
// Model: Claude Sonnet (good analysis, ~2c per audit).

const MODEL = 'claude-sonnet-5';

function readBody(req) {
  return new Promise(function (resolve) {
    if (req.body) { resolve(typeof req.body === 'string' ? safeParse(req.body) : req.body); return; }
    var raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () { resolve(safeParse(raw)); });
    req.on('error', function () { resolve({}); });
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

function summariseAudit(d) {
  var L = [];
  var host = d.url || '';
  L.push('Store URL: ' + host);
  L.push('Device tested: ' + (d.strategy || 'mobile'));
  if (d.platform && d.platform.fetched) {
    L.push('Platform: ' + (d.platform.isShopify ? 'Shopify' : 'Not detected as Shopify'));
    if (d.platform.theme && d.platform.theme.name) L.push('Theme: ' + d.platform.theme.name);
    if (d.platform.apps && d.platform.apps.length) {
      L.push('Detected apps: ' + d.platform.apps.map(function (a) { return a.name + ' (' + a.cat + ')'; }).join(', '));
    }
  }
  L.push('Performance score: ' + (d.score === null || d.score === undefined ? 'N/A' : d.score + '/100'));
  if (d.field) {
    var fv = [];
    if (d.field.lcp) fv.push('LCP ' + d.field.lcp.p + 'ms (' + d.field.lcp.cat + ')');
    if (d.field.inp) fv.push('INP ' + d.field.inp.p + 'ms (' + d.field.inp.cat + ')');
    if (d.field.cls) fv.push('CLS ' + (d.field.cls.p / 100).toFixed(2) + ' (' + d.field.cls.cat + ')');
    if (fv.length) L.push('Core Web Vitals (real users): ' + fv.join(', '));
  }
  if (d.lab) {
    L.push('Lab metrics: FCP ' + (d.lab.fcp.value || '-') + ', LCP ' + (d.lab.lcp.value || '-') + ', TBT ' + (d.lab.tbt.value || '-') + ', CLS ' + (d.lab.cls.value || '-') + ', Speed Index ' + (d.lab.si.value || '-'));
  }
  if (d.opportunities && d.opportunities.length) {
    L.push('Top opportunities (est. time saved):');
    d.opportunities.forEach(function (o) { L.push('- ' + o.title + ' (~' + Math.round(o.savingsMs) + 'ms): ' + (o.description || '')); });
  }
  if (d.diagnostics && d.diagnostics.length) {
    L.push('Diagnostics: ' + d.diagnostics.map(function (g) { return g.title + (g.value ? ' (' + g.value + ')' : ''); }).join('; '));
  }
  return L.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST.' }); return; }
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(400).json({ error: 'Anthropic API key not set. Add ANTHROPIC_API_KEY in Vercel > Settings > Environment Variables, then redeploy.', needsSetup: true }); return; }

  var d = await readBody(req);
  if (!d || !d.url) { res.status(400).json({ error: 'No audit data provided.' }); return; }

  var system = 'You are a senior Shopify ecommerce consultant at a specialist agency (Good Morning Charlie). '
    + 'You are writing an INTERNAL briefing for the agency team (Griff and Holly) to act on when working with this store — not a message to the client. '
    + 'Be concrete, prioritised and practical. Focus on what to fix, in what order, why it matters for conversion/revenue, and Shopify-specific guidance where relevant (theme, apps, Liquid, images, third-party scripts). '
    + 'Avoid fluff and generic advice. Use short Markdown sections and bullet points. Keep it under ~450 words.';

  var user = 'Here is the automated audit data for a store. Write the internal action briefing.\n\n' + summariseAudit(d);

  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: system, messages: [{ role: 'user', content: user }] })
    });
    var data = await r.json();
    if (!r.ok || data.error) {
      var msg = (data.error && data.error.message) ? data.error.message : 'Anthropic API error.';
      res.status(400).json({ error: msg });
      return;
    }
    var text = '';
    if (Array.isArray(data.content)) {
      text = data.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
    }
    res.status(200).json({ insights: text || 'No insights returned.', model: MODEL });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the AI service. Try again shortly.' });
  }
}
