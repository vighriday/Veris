import Stripe from 'stripe';
import { db } from '../db/client';
import { sendEmail } from '../utils/notifier';

const stripe = new Stripe(process.env.STRIPE_KEY || 'sk_test_x', { apiVersion: '2024-06-20' });

export async function processPayment(orderId: string, amountCents: number, customerId: string) {
  const charge = await stripe.charges.create({
    amount: amountCents,
    currency: 'usd',
    customer: customerId,
    description: `order ${orderId}`
  });

  await db.query(
    `INSERT INTO payments (order_id, stripe_id, amount_cents, status) VALUES ($1, $2, $3, $4)`,
    [orderId, charge.id, amountCents, charge.status]
  );

  await sendEmail(customerId, 'Payment received', `Charge ${charge.id} for $${amountCents / 100}`);
  return charge;
}

export async function refund(chargeId: string) {
  const r = await stripe.refunds.create({ charge: chargeId });
  await db.query(`UPDATE payments SET status = 'refunded' WHERE stripe_id = $1`, [chargeId]);
  return r;
}
