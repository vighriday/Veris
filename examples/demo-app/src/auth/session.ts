import { redis } from '../cache/redisClient';

const SESSION_TTL_SEC = 60 * 15;

export async function issueSession(userId: string, token: string) {
  await redis.set(`session:${userId}`, token, 'EX', SESSION_TTL_SEC);
}

export async function getSession(userId: string): Promise<string | null> {
  return redis.get(`session:${userId}`);
}

export async function revokeSession(userId: string) {
  await redis.del(`session:${userId}`);
}
