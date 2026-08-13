// Docket -> Adzuna Jobs API proxy.
//
// Pulls live job listings for a search (what + where) from Adzuna, the
// legitimate AU job aggregator. Credentials are read from environment
// variables and never touch the browser:
//   ADZUNA_APP_ID   - your Adzuna application id
//   ADZUNA_APP_KEY  - your Adzuna application key
// Get a free key at https://developer.adzuna.com , then add both in
// Vercel > Project Settings > Environment Variables and redeploy.
//
// Query params:
//   what   - keywords / role (e.g. "shopify developer")
//   where  - location (e.g. "Perth" or "Australia"); default Australia
//   country- Adzuna country code; default "au"
//   maxDaysOld - only jobs posted within N days; default 14

export default async function handler(req, res) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    res.status(400).json({
      error: 'Adzuna keys are not set. Add ADZUNA_APP_ID and ADZUNA_APP_KEY in Vercel > Settings > Environment Variables, then redeploy.',
      needsSetup: true
    });
    return;
  }

  const what = (req.query.what || '').toString().trim();
  const where = (req.query.where || '').toString().trim();
  const country = (req.query.country || 'au').toString().toLowerCase().replace(/[^a-z]/g, '') || 'au';
  const maxDaysOld = Math.max(1, Math.min(60, parseInt(req.query.maxDaysOld || '14', 10) || 14));

  if (!what) {
    res.status(400).json({ error: 'Add a role or keywords to search for.' });
    return;
  }

  try {
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: '20',
      what: what,
      max_days_old: String(maxDaysOld),
      sort_by: 'date',
      'content-type': 'application/json'
    });
    if (where) params.set('where', where);
    var jobtype = (req.query.jobtype || '').toString().toLowerCase();
    if (jobtype === 'contract') params.set('contract', '1');
    else if (jobtype === 'permanent') params.set('permanent', '1');

    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params.toString()}`;
    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok || data.exception) {
      res.status(400).json({ error: (data && data.display) ? data.display : 'Adzuna API error. Check your keys and search.' });
      return;
    }

    const jobs = (Array.isArray(data.results) ? data.results : []).map(function (j) {
      return {
        id: String(j.id || (j.redirect_url || '') ),
        title: j.title || 'Untitled role',
        company: (j.company && j.company.display_name) || 'Unknown company',
        location: (j.location && j.location.display_name) || '',
        created: j.created || null,
        url: j.redirect_url || '',
        salary: (j.salary_min || j.salary_max)
          ? ('$' + Math.round(j.salary_min || j.salary_max).toLocaleString() + (j.salary_max && j.salary_max !== j.salary_min ? '–$' + Math.round(j.salary_max).toLocaleString() : ''))
          : '',
        contractType: j.contract_type || '',
        contractTime: j.contract_time || '',
        snippet: (j.description || '').slice(0, 180)
      };
    });

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.status(200).json({ jobs: jobs, count: data.count || jobs.length });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach Adzuna. Try again shortly.' });
  }
}
