import { db } from './client';

export async function getOrdersWithItems(userId: string) {
  const orders = await db.query(`SELECT * FROM orders WHERE user_id = $1`, [userId]);
  const result = [] as any[];
  for (const o of orders.rows) {
    const items = await db.query(`SELECT * FROM order_items WHERE order_id = $1`, [o.id]);
    result.push({ ...o, items: items.rows });
  }
  return result;
}

export async function migrate() {
  await db.query(`CREATE TABLE IF NOT EXISTS orders (id serial primary key, user_id text, total_cents int, status text)`);
  await db.query(`CREATE TABLE IF NOT EXISTS order_items (id serial primary key, order_id int, sku text, qty int)`);
}
