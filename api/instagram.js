// Docket -> Instagram Graph API proxy.
//
// Fetches YOUR OWN posts for the connected professional account. The access
// token is read from the IG_TOKEN environment variable (set it in Vercel:
// Project Settings > Environment Variables). The token never touches the
// browser, and this runs server-side so Instagram's CORS rules don't block it.
//
// Set up (see README): convert the PIT Instagram to a Professional account,
// create a Meta app, generate a long-lived Instagram user access token, and
// paste it into the IG_TOKEN env var. Long-lived tokens last ~60 days; this
// function refreshes it opportunistically on each call (best effort).

export default async function handler(req, res) {
  const token = process.env.IG_TOKEN;
  if (!token) {
    res.status(400).json({ error: 'IG_TOKEN is not set. Add it in Vercel > Settings > Environment Variables, then redeploy.' });
    return;
  }

  const fields = 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp';

  try {
    const url = `https://graph.instagram.com/me/media?fields=${fields}&limit=33&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.error) {
      res.status(400).json({ error: data.error.message || 'Instagram API error', code: data.error.code || null });
      return;
    }

    // Best-effort refresh so the token keeps living (does not need the app secret).
    // We cannot persist the refreshed token to the env var, but refreshing
    // extends the CURRENT token's life, which buys time before a manual reissue.
    try {
      await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
    } catch (e) { /* ignore */ }

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
    res.status(200).json({ media: Array.isArray(data.data) ? data.data : [] });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach Instagram: ' + String(e && e.message || e) });
  }
}
