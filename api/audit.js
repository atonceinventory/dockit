// Dockit -> Google PageSpeed Insights (Lighthouse) audit proxy.
//
// Runs a real performance audit on a URL and returns structured data:
// overall score, Core Web Vitals (field + lab), and Google's own
// optimisation opportunities.
//
// Optional env var for higher quota / reliability:
//   PAGESPEED_API_KEY  - a Google API key with "PageSpeed Insights API" enabled.
// Works without a key at low volume, but Google rate-limits keyless calls.
//
// Query params:
//   url       - the site to audit (required)
//   strategy  - "mobile" (default) or "desktop"

export default async function handler(req, res) {
  var url = (req.query.url || '').toString().trim();
  var strategy = ((req.query.strategy || 'mobile').toString().toLowerCase() === 'desktop') ? 'desktop' : 'mobile';

  if (!url) { res.status(400).json({ error: 'Enter a URL to audit.' }); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch (e) { res.status(400).json({ error: 'That does not look like a valid URL.' }); return; }

  var key = process.env.PAGESPEED_API_KEY || '';
  var api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    + '?url=' + encodeURIComponent(url)
    + '&strategy=' + strategy
    + '&category=performance'
    + (key ? ('&key=' + key) : '');

  try {
    var r = await fetch(api);
    var data = await r.json();

    if (!r.ok || data.error) {
      var msg = (data.error && data.error.message) ? data.error.message : 'PageSpeed could not analyse that URL.';
      var needsKey = /quota|rate|keyless|dailyLimit|userRateLimit/i.test(msg);
      res.status(400).json({ error: msg, needsSetup: needsKey });
      return;
    }

    var lh = data.lighthouseResult || {};
    var audits = lh.audits || {};
    var score = (lh.categories && lh.categories.performance && typeof lh.categories.performance.score === 'number')
      ? Math.round(lh.categories.performance.score * 100) : null;

    function metric(id){
      var a = audits[id] || {};
      return { value: a.displayValue || '', ms: (typeof a.numericValue === 'number') ? a.numericValue : null, score: (typeof a.score === 'number') ? a.score : null };
    }
    var lab = {
      fcp: metric('first-contentful-paint'),
      lcp: metric('largest-contentful-paint'),
      tbt: metric('total-blocking-time'),
      cls: metric('cumulative-layout-shift'),
      si:  metric('speed-index'),
      tti: metric('interactive')
    };

    // Field data (real users, from CrUX) if available
    var field = null;
    var le = data.loadingExperience;
    if (le && le.metrics) {
      function f(id){ var m = le.metrics[id]; return m ? { p: m.percentile, cat: m.category } : null; }
      field = {
        overall: le.overall_category || null,
        lcp: f('LARGEST_CONTENTFUL_PAINT_MS'),
        inp: f('INTERACTION_TO_NEXT_PAINT'),
        cls: f('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
        fcp: f('FIRST_CONTENTFUL_PAINT_MS')
      };
    }

    // Opportunities — Google's own, savings-ranked optimisation suggestions
    var opportunities = [];
    Object.keys(audits).forEach(function(k){
      var a = audits[k];
      if (a && a.details && a.details.type === 'opportunity' && a.details.overallSavingsMs > 30) {
        opportunities.push({
          title: a.title || k,
          savingsMs: Math.round(a.details.overallSavingsMs),
          description: (a.description || '').replace(/\s*\[.*?\]\(.*?\)/g, '').trim()
        });
      }
    });
    opportunities.sort(function(a,b){ return b.savingsMs - a.savingsMs; });
    opportunities = opportunities.slice(0, 10);

    // Failed diagnostics worth noting (non-opportunity, scored, failing)
    var diagnostics = [];
    ['uses-responsive-images','offscreen-images','render-blocking-resources','unused-css-rules',
     'unused-javascript','uses-optimized-images','uses-text-compression','server-response-time',
     'mainthread-work-breakdown','dom-size','third-party-summary','uses-long-cache-ttl'].forEach(function(id){
      var a = audits[id];
      if (a && typeof a.score === 'number' && a.score < 0.9) {
        diagnostics.push({ title: a.title || id, value: a.displayValue || '', description: (a.description || '').replace(/\s*\[.*?\]\(.*?\)/g, '').trim() });
      }
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    res.status(200).json({
      url: url, finalUrl: lh.finalUrl || url, strategy: strategy,
      fetchedAt: new Date().toISOString(),
      score: score, lab: lab, field: field,
      opportunities: opportunities, diagnostics: diagnostics
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach PageSpeed Insights. Try again shortly.' });
  }
}
