import { redis } from './redisClient';
import { db } from '../db/client';

const TTL = 60;

export async function getProduct(id: string) {
  const cached = await redis.get(`product:${id}`);
  if (cached) return JSON.parse(cached);

  const row = await db.query(`SELECT * FROM products WHERE id = $1`, [id]);
  const product = row.rows[0];

  await redis.set(`product:${id}`, JSON.stringify(product), 'EX', TTL);
  return product;
}

export async function updateProduct(id: string, patch: Record<string, any>) {
  await db.query(`UPDATE products SET name = $2, price_cents = $3 WHERE id = $1`, [
    id,
    patch.name,
    patch.priceCents
  ]);
}

export async function invalidate(id: string) {
  await redis.del(`product:${id}`);
}

export function memoize<T>(fn: (k: string) => Promise<T>) {
  const m = new Map<string, T>();
  return async (k: string) => {
    if (m.has(k)) return m.get(k)!;
    const v = await fn(k);
    m.set(k, v);
    return v;
  };
}
