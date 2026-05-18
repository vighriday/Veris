import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { findUserByEmail } from '../db/userRepo';
import { issueSession } from './session';

const SECRET = process.env.JWT_SECRET || 'dev-secret';

export async function login(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user) throw new Error('no user');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error('bad creds');

  const token = jwt.sign({ sub: user.id }, SECRET, { expiresIn: '15m' });
  await issueSession(user.id, token);
  return { token, userId: user.id };
}

export function verifyToken(token: string): { sub: string; exp: number } {
  const decoded = jwt.verify(token, SECRET) as any;
  const nowSec = Math.floor(Date.now() / 1000);
  if (decoded.exp < nowSec) {
    throw new Error('expired');
  }
  return decoded;
}

export async function refreshToken(oldToken: string) {
  const decoded = verifyToken(oldToken);
  const fresh = jwt.sign({ sub: decoded.sub }, SECRET, { expiresIn: '15m' });
  return fresh;
}
