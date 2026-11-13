// Solis membership: Stripe Connect OAuth return.
// GET /api/solis/connected?code=...&state=...
//
// Dom connects his own Standard Stripe account to the GMC platform by opening the
// OAuth link (see CONNECT_URL in the message to him). After he approves, Stripe sends
// him here with a one-time code. This endpoint swaps the code for his account id and
// shows it on screen, so it can be copied into SOLIS_STRIPE_ACCOUNT in Vercel.
// The account id is also written to Firestore config/connect_<mode> for safekeeping.
//
// Nothing else changes until SOLIS_STRIPE_ACCOUNT is updated and the function redeploys.
//
// Env: SOLIS_STRIPE_SECRET_KEY (live key when connecting the real account),
//      SOLIS_CONNECT_STATE (optional) shared secret that must match the ?state= value.

import { env, fsMerge } from './_lib.js';

function page(res, status, title, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow"><title>' + title + '</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;line-height:1.5">' +
    '<h1 style="font-size:1.25rem">' + title + '</h1>' + body + '</body>');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end('Method not allowed');
  }

  const q = new URL(req.url, 'https://x').searchParams;
  if (q.get('error')) {
    return page(res, 400, 'Connection not completed',
      '<p>Stripe reported: ' + (q.get('error_description') || q.get('error')) + '.</p>' +
      '<p>Nothing was changed. Ask Griff for a fresh link if you want to try again.</p>');
  }

  const code = q.get('code');
  if (!code) return page(res, 400, 'Missing code', '<p>This page is only reached from Stripe after approving the connection.</p>');

  const expectedState = env('SOLIS_CONNECT_STATE', '');
  if (expectedState && q.get('state') !== expectedState) {
    return page(res, 400, 'Invalid link', '<p>This connection link is not valid. Ask Griff for a fresh one.</p>');
  }

  try {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: code });
    const r = await fetch('https://connect.stripe.com/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env('SOLIS_STRIPE_SECRET_KEY'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error_description || data.error || ('Stripe HTTP ' + r.status));

    const acct = data.stripe_user_id;
    const live = !!data.livemode;
    try {
      await fsMerge('config/connect_' + (live ? 'live' : 'test'), {
        accountId: acct, livemode: live, connectedAt: new Date()
      });
    } catch (e) {
      console.error('[solis/connected] firestore', e.message);
    }

    return page(res, 200, 'Solis is connected',
      '<p>Your Stripe account is now connected to Good Morning Charlie. You can close this page.</p>' +
      '<p style="color:#666;font-size:.9em">Account: <code>' + acct + '</code>' + (live ? '' : ' (test mode)') + '</p>');
  } catch (err) {
    console.error('[solis/connected]', err.message);
    return page(res, 500, 'Something went wrong',
      '<p>The connection could not be completed. Please tell Griff, and nothing further is needed from you right now.</p>');
  }
}
