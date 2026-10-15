// Solis membership: data retention clean-up (runs daily via Vercel Cron).
// GET /api/solis/cleanup  (Vercel sends "Authorization: Bearer <CRON_SECRET>")
//
// Deletes members whose membership ended more than SOLIS_RETENTION_DAYS ago
// (default 730 = 2 years). Stripe keeps its own payment records for tax purposes,
// so this only removes the copy in the Solis members list.

import { env, fsWhereEqual, fsDelete } from './_lib.js';

const DAY = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const secret = env('CRON_SECRET', '');
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'unauthorised' }));
  }

  try {
    const days = Number(env('SOLIS_RETENTION_DAYS', '730'));
    const cutoff = Date.now() - days * DAY;
    const cancelled = await fsWhereEqual('members', 'status', 'cancelled');
    const expired = cancelled.filter(function (m) {
      const ended = m.data.endedAt || m.data.currentPeriodEnd;
      return ended instanceof Date && ended.getTime() < cutoff;
    });
    for (const m of expired) await fsDelete('members/' + m.id);
    console.log('[solis/cleanup] checked', cancelled.length, 'cancelled, deleted', expired.length);
    res.statusCode = 200;
    return res.end(JSON.stringify({ checked: cancelled.length, deleted: expired.length }));
  } catch (err) {
    console.error('[solis/cleanup]', err.message);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'cleanup failed' }));
  }
}
