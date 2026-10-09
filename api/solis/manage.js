// Solis membership: "Manage membership" button target.
// GET /api/solis/manage  ->  redirects to the Stripe customer portal login page for the
// Solis connected account. Members enter their email, Stripe emails them a one-time link,
// and they can update their card, see receipts, or cancel (at the end of the fortnight).
//
// The portal configuration is created on first use and its login URL cached in Firestore
// (config/portal_<account>_<mode>), so this works unchanged after the swap to live keys.

import { env, stripe, fsGet, fsMerge, redirect, errorPage } from './_lib.js';

const FEATURES = {
  customer_update: { enabled: true, allowed_updates: ['email', 'name', 'phone'] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: {
    enabled: true,
    mode: 'at_period_end',
    cancellation_reason: { enabled: true, options: ['too_expensive', 'unused', 'other'] }
  }
};

async function portalLoginUrl(account, returnUrl) {
  const mode = env('SOLIS_STRIPE_SECRET_KEY').indexOf('_live_') !== -1 ? 'live' : 'test';
  const cacheId = 'config/portal_' + account + '_' + mode;
  const cached = await fsGet(cacheId);
  if (cached && cached.loginUrl) return cached.loginUrl;

  const params = {
    business_profile: { headline: 'Manage your Solis membership' },
    features: FEATURES,
    login_page: { enabled: true },
    default_return_url: returnUrl
  };

  // Prefer the account's default portal configuration so the login page belongs to it.
  const list = await stripe('GET', '/billing_portal/configurations', { is_default: true, limit: 1 }, { account: account });
  let config;
  if (list.data && list.data.length) {
    config = await stripe('POST', '/billing_portal/configurations/' + list.data[0].id, params, { account: account });
  } else {
    config = await stripe('POST', '/billing_portal/configurations', params, { account: account });
  }

  const url = config.login_page && config.login_page.url;
  if (!url) throw new Error('Portal configuration ' + config.id + ' has no login page URL');
  await fsMerge(cacheId, { loginUrl: url, configId: config.id, updatedAt: new Date() });
  return url;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end('Method not allowed');
  }
  let back = '';
  try {
    back = env('SOLIS_CANCEL_URL');
    const url = await portalLoginUrl(env('SOLIS_STRIPE_ACCOUNT'), back);
    return redirect(res, url);
  } catch (err) {
    console.error('[solis/manage]', err.message, err.stripe || '');
    return errorPage(res, 500,
      'We could not open membership management just now. Please try again shortly, or contact the gym.',
      back || null);
  }
}
