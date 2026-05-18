import { db } from '../db/client';
import { processPayment } from './charge';
import { enqueueFulfillment } from '../queue/fulfillment';

export async function placeOrder(cartId: string, userId: string) {
  const items = await db.query(`SELECT * FROM cart_items WHERE cart_id = $1`, [cartId]);
  const total = items.rows.reduce((s: number, i: any) => s + i.price_cents * i.qty, 0);

  const order = await db.query(
    `INSERT INTO orders (user_id, total_cents, status) VALUES ($1, $2, 'pending') RETURNING *`,
    [userId, total]
  );
  const orderId = order.rows[0].id;

  const charge = await processPayment(orderId, total, userId);

  if (charge.status === 'succeeded') {
    await db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [orderId]);
    await enqueueFulfillment(orderId);
  }

  return order.rows[0];
}

export async function finalizeOrder(orderId: string) {
  await db.query(`UPDATE orders SET status = 'finalized' WHERE id = $1`, [orderId]);
}
