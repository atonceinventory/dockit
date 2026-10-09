// Solis membership: Stripe Connect webhook.
// POST /api/solis/webhook  (register in GMC's Stripe as a Connect endpoint, "events on connected accounts")
//
// Keeps members/{stripeCustomerId} in the solis-membership Firestore up to date:
//   status: active | past_due | cancelled | incomplete | paused
// On every relevant event the subscription is re-fetched from Stripe and written in full,
// so out-of-order or repeated deliveries always end in the correct state.
//
// Events: checkout.session.completed, customer.subscription.created/updated/deleted,
//         invoice.paid, invoice.payment_failed

import { env, stripe, verifyStripeSignature, readRawBody, fsMerge } from './_lib.js';

const STATUS = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
  incomplete_expired: 'cancelled',
  incomplete: 'incomplete',
  paused: 'paused'
};

function ts(sec) { return sec ? new Date(sec * 1000) : undefined; }

// Newer API versions moved period end onto subscription items.
function periodEnd(sub) {
  if (sub.current_period_end) return sub.current_period_end;
  const item = sub.items && sub.items.data && sub.items.data[0];
  return item && item.current_period_end;
}

// Newer API versions moved invoice.subscription under parent.subscription_details.
export function invoiceSubscriptionId(inv) {
  if (typeof inv.subscription === 'string') return inv.subscription;
  if (inv.subscription && inv.subscription.id) return inv.subscription.id;
  const d = inv.parent && inv.parent.subscription_details;
  if (d && d.subscription) return typeof d.subscription === 'string' ? d.subscription : d.subscription.id;
  return null;
}

export async function syncSubscription(subId, account, extra) {
  extra = extra || {};
  const sub = await stripe('GET', '/subscriptions/' + subId, { expand: ['customer'] }, { account: account });
  const cust = sub.customer && typeof sub.customer === 'object' ? sub.customer : { id: sub.customer };
  const details = extra.customerDetails || {};
  const item = sub.items && sub.items.data && sub.items.data[0];

  const doc = {
    customerId: cust.id,
    subscriptionId: sub.id,
    name: details.name || cust.name || '',
    email: details.email || cust.email || '',
    phone: details.phone || cust.phone || '',
    status: STATUS[sub.status] || sub.status,
    stripeStatus: sub.status,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: ts(periodEnd(sub)),
    endedAt: ts(sub.ended_at),
    joinedAt: ts(sub.start_date || sub.created),
    amountCents: item && item.price ? item.price.unit_amount : undefined,
    livemode: !!sub.livemode,
    updatedAt: new Date()
  };
  if (extra.lastPaymentAt) doc.lastPaymentAt = extra.lastPaymentAt;
  if (extra.lastPaymentFailedAt) doc.lastPaymentFailedAt = extra.lastPaymentFailedAt;

  await fsMerge('members/' + cust.id, doc);
  return doc;
}

export async function handleEvent(event, account) {
  const obj = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && obj.subscription) {
        const sid = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
        return syncSubscription(sid, account, { customerDetails: obj.customer_details });
      }
      return null;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return syncSubscription(obj.id, account);
    case 'invoice.paid': {
      const sid = invoiceSubscriptionId(obj);
      if (!sid) return null;
      const paid = obj.status_transitions && obj.status_transitions.paid_at;
      return syncSubscription(sid, account, { lastPaymentAt: paid ? new Date(paid * 1000) : new Date() });
    }
    case 'invoice.payment_failed': {
      const sid = invoiceSubscriptionId(obj);
      if (!sid) return null;
      return syncSubscription(sid, account, { lastPaymentFailedAt: new Date() });
    }
    default:
      return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end('Method not allowed');
  }

  let event;
  try {
    const raw = await readRawBody(req);
    verifyStripeSignature(raw, req.headers['stripe-signature'], env('SOLIS_STRIPE_WEBHOOK_SECRET'));
    event = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    console.error('[solis/webhook] rejected:', err.message);
    res.statusCode = 400;
    return res.end('Bad request');
  }

  const account = env('SOLIS_STRIPE_ACCOUNT');
  res.setHeader('Content-Type', 'application/json');
  if (event.account !== account) {
    // Another connected account (or a platform event). Acknowledge and ignore.
    res.statusCode = 200;
    return res.end(JSON.stringify({ ignored: true }));
  }

  try {
    await handleEvent(event, account);
    res.statusCode = 200;
    return res.end(JSON.stringify({ received: true }));
  } catch (err) {
    // 500 makes Stripe retry with backoff.
    console.error('[solis/webhook]', event.type, event.id, err.message);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'sync failed' }));
  }
}
