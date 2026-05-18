const crypto = require('crypto');
const { db } = require('../db/client');
const { sendEmail } = require('../utils/notifier');

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_x';

function verifySignature(payload, sigHeader) {
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  return expected === sigHeader;
}

async function handleEvent(req, res) {
  const sig = req.headers['stripe-signature'];
  const raw = req.rawBody;
  if (!verifySignature(raw, sig)) return res.status(400).send('bad sig');

  const event = JSON.parse(raw);

  if (event.type === 'charge.succeeded') {
    const chargeId = event.data.object.id;
    const orderId = event.data.object.metadata.order_id;

    await db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [orderId]);
    await sendEmail(event.data.object.customer, 'Payment confirmed', `Order ${orderId} paid`);
  }

  if (event.type === 'charge.refunded') {
    const orderId = event.data.object.metadata.order_id;
    await db.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [orderId]);
  }

  res.status(200).send('ok');
}

module.exports = { handleEvent, verifySignature };
