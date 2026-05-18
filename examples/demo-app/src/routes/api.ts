import express from 'express';
import { login, verifyToken } from '../auth/login';
import { placeOrder } from '../payments/checkout';
import { getProduct } from '../cache/productCache';
import { handleEvent as handleStripeWebhook } from '../webhooks/stripeWebhook';

export const router = express.Router();

function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).send('no auth');
  try {
    req.user = verifyToken(auth.replace('Bearer ', ''));
    next();
  } catch {
    res.status(401).send('bad token');
  }
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const r = await login(email, password);
  res.json(r);
});

router.get('/products/:id', async (req, res) => {
  const p = await getProduct(req.params.id);
  res.json(p);
});

router.post('/orders', requireAuth, async (req, res) => {
  const order = await placeOrder(req.body.cartId, req.user.sub);
  res.json(order);
});

router.post('/webhooks/stripe', handleStripeWebhook as any);

router.get('/admin/users', async (req, res) => {
  res.json({ users: [] });
});
