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

    const privacyUrl = env('SOLIS_PRIVACY_URL', '');
    const termsUrl = env('SOLIS_TERMS_URL', '');

    // Shown above the Subscribe button: makes the subscription and how to cancel clear
    // before payment, and gives the privacy collection notice at the point of sign-up.
    let notice = 'This is an ongoing membership: you will be charged $50 every 2 weeks until you cancel. ' +
      'Cancel anytime online via Manage my membership on the Solis website. ' +
      'Your name, email and phone are collected by Solis to run your membership. Payments are processed by Stripe, ' +
      'and your details are handled by Solis\'s service providers, some of whom store data overseas.';
    if (privacyUrl) notice += ' See the [Solis Privacy Policy](' + privacyUrl + ').';
    if (termsUrl) notice += ' Membership is subject to the [Solis Membership Terms](' + termsUrl + ').';

    const params = {
      mode: 'subscription',
      line_items: [{ price: env('SOLIS_PRICE_ID'), quantity: 1 }],
      subscription_data: { application_fee_percent: fee },
      phone_number_collection: { enabled: true },
      billing_address_collection: 'auto',
      custom_text: { submit: { message: notice } },
      success_url: successUrl + joiner + 'session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl
    };
    // Tick-box acceptance of terms. Stripe requires a Terms of Service URL in the
    // connected account's public details before this can be switched on.
    if (env('SOLIS_REQUIRE_TERMS', '') === '1' && termsUrl) {
      params.consent_collection = { terms_of_service: 'required' };
      params.custom_text.terms_of_service_acceptance = {
        message: 'I agree to the [Solis Membership Terms](' + termsUrl + ').'
      };
    }

    const session = await stripe('POST', '/checkout/sessions', params, { account: env('SOLIS_STRIPE_ACCOUNT') });

    return redirect(res, session.url);
  } catch (err) {
    console.error('[solis/join]', err.message, err.stripe || '');
    return errorPage(res, 500,
      'We could not start the sign-up just now. Please try again in a minute, or contact the gym.',
      cancelUrl || null);
  }
}
