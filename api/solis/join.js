// Solis membership: "Join" button target.
// GET /api/solis/join  ->  creates a Stripe Checkout session (subscription) on the Solis
// connected account with GMC's application fee, then redirects the member to Stripe.
// The Squarespace Join button is just a link to this URL.

import { env, stripe, redirect, errorPage } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST');
    return res.end('Method not allowed');
  }

  let cancelUrl = '';
  try {
    cancelUrl = env('SOLIS_CANCEL_URL');
    const fee = Number(env('SOLIS_FEE_PERCENT', '5'));
    const successUrl = env('SOLIS_SUCCESS_URL');
    const joiner = successUrl.indexOf('?') === -1 ? '?' : '&';

    const session = await stripe('POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: env('SOLIS_PRICE_ID'), quantity: 1 }],
      subscription_data: { application_fee_percent: fee },
      phone_number_collection: { enabled: true },
      billing_address_collection: 'auto',
      success_url: successUrl + joiner + 'session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl
    }, { account: env('SOLIS_STRIPE_ACCOUNT') });

    return redirect(res, session.url);
  } catch (err) {
    console.error('[solis/join]', err.message, err.stripe || '');
    return errorPage(res, 500,
      'We could not start the sign-up just now. Please try again in a minute, or contact the gym.',
      cancelUrl || null);
  }
}
