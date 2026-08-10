import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as crypto from 'crypto';
import { CreditProductType, PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { logAudit } from './audit';
import * as midtransService from './midtrans';
import * as quotaService from './quota.service';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6009;
const IDENTITY_URL = process.env.IDENTITY_SERVICE_URL || 'http://identity:6001';
const VALID_PRODUCT_TYPES: CreditProductType[] = ['ai_credit', 'broadcast_quota', 'warmer_slot'];

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'billing' }));

const getUser = async (id: string): Promise<{ id: string; name: string; email: string } | null> => {
  const resp = await fetch(`${IDENTITY_URL}/internal/users/${id}`);
  if (!resp.ok) return null;
  return resp.json() as any;
};

// ---- Internal (called by other services) ----

app.get('/internal/quota/:userId', async (req, res) => {
  const quota = await quotaService.getQuota(req.params.userId);
  return res.json(quota);
});

app.patch('/internal/quota/:userId', async (req, res) => {
  const { maxDevices, broadcastQuotaMonthly, maxWarmerSessions, broadcastSentThisMonthIncrement } = req.body;
  await quotaService.getQuota(req.params.userId);
  const updated = await prisma.userQuota.update({
    where: { userId: req.params.userId },
    data: {
      maxDevices, broadcastQuotaMonthly, maxWarmerSessions,
      broadcastSentThisMonth: broadcastSentThisMonthIncrement ? { increment: broadcastSentThisMonthIncrement } : undefined,
    },
  });
  return res.json(updated);
});

app.get('/internal/quota/:userId/ai-credit/check', async (req, res) => {
  return res.json({ hasBalance: await quotaService.hasAiBalance(req.params.userId) });
});

app.post('/internal/quota/:userId/ai-credit/consume', async (req, res) => {
  const newBalance = await quotaService.consumeAiCredit(req.params.userId);
  if (newBalance !== null) await quotaService.publishQuotaUpdated(req.params.userId, 'ai_credit', newBalance);
  return res.json({ newBalance });
});

// ---- Credits (admin top-up + ledger) ----

app.post('/credits/:userId/topup', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden: only admins can top up AI credits' });
  const { userId } = req.params;
  const { amount, note } = req.body;
  if (!amount || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Parameter "amount" must be a positive number' });

  try {
    const target = await getUser(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const newBalance = await quotaService.topUpAiCredit(req.user!.id, userId, amount, note);
    await quotaService.publishQuotaUpdated(userId, 'ai_credit', newBalance);
    logAudit(req.user!.id, 'credit.topup', `Topped up ${amount} AI credits for "${target.email}" (new balance: ${newBalance})`);
    return res.json({ aiCreditBalance: newBalance });
  } catch (err: any) {
    console.error('Top up credit error:', err);
    return res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/credits/:userId/transactions', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { userId } = req.params;
  if (req.user!.role !== 'admin' && userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const transactions = await prisma.aiCreditTransaction.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return res.json(transactions);
  } catch (err) {
    console.error('Get credit transactions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Credit packages ----

app.get('/credit-packages', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const packages = await prisma.creditPackage.findMany({ where: req.user!.role === 'admin' ? {} : { isActive: true }, orderBy: [{ productType: 'asc' }, { quotaAmount: 'asc' }] });
  return res.json(packages);
});

app.post('/credit-packages', authenticateJWT, async (req, res) => {
  const { name, productType, quotaAmount, priceRp } = req.body;
  if (!name || !quotaAmount || !priceRp || quotaAmount <= 0 || priceRp <= 0) return res.status(400).json({ error: 'Parameters "name", "quotaAmount" and "priceRp" (all positive) are required' });
  if (productType !== undefined && !VALID_PRODUCT_TYPES.includes(productType)) return res.status(400).json({ error: 'Invalid productType' });
  const pkg = await prisma.creditPackage.create({ data: { name, productType: productType || 'ai_credit', quotaAmount, priceRp } });
  return res.status(201).json(pkg);
});

app.patch('/credit-packages/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { name, quotaAmount, priceRp, isActive } = req.body;
  const pkg = await prisma.creditPackage.findUnique({ where: { id } });
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  const updated = await prisma.creditPackage.update({ where: { id }, data: { name, quotaAmount, priceRp, isActive } });
  return res.json(updated);
});

app.delete('/credit-packages/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const force = req.body?.force === true;
  const pkg = await prisma.creditPackage.findUnique({ where: { id } });
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  const orderCount = await prisma.creditOrder.count({ where: { packageId: id } });
  if (orderCount === 0 || force) {
    await prisma.creditPackage.delete({ where: { id } });
    return res.json({ message: 'Package dihapus permanen', deleted: true });
  }
  await prisma.creditPackage.update({ where: { id }, data: { isActive: false } });
  return res.json({ message: `Package sudah pernah dibeli (${orderCount}x) - dinonaktifkan. Konfirmasi sekali lagi untuk menghapus permanen.`, deleted: false });
});

// ---- Credit orders (Midtrans) ----

app.post('/credit-orders', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { packageId } = req.body;
  if (!packageId) return res.status(400).json({ error: 'Parameter "packageId" is required' });
  try {
    const pkg = await prisma.creditPackage.findFirst({ where: { id: packageId, isActive: true } });
    if (!pkg) return res.status(404).json({ error: 'Package not found or no longer available' });
    const user = await getUser(req.user!.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const midtransOrderId = `CR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const { token } = await midtransService.createSnapTransaction({ orderId: midtransOrderId, grossAmount: pkg.priceRp, customerName: user.name, customerEmail: user.email });
    const order = await prisma.creditOrder.create({
      data: { userId: user.id, packageId: pkg.id, quotaAmount: pkg.quotaAmount, productType: pkg.productType, priceRp: pkg.priceRp, midtransOrderId, snapToken: token, status: 'pending' },
    });
    return res.status(201).json({ token, orderId: order.midtransOrderId });
  } catch (err: any) {
    console.error('Create credit order error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/midtrans/webhook', async (req, res) => {
  const { order_id, status_code, gross_amount, transaction_status, fraud_status, signature_key } = req.body;
  if (!order_id || !status_code || !gross_amount || !signature_key) return res.status(400).json({ error: 'Malformed notification payload' });
  if (!midtransService.verifySignature({ orderId: order_id, statusCode: status_code, grossAmount: gross_amount, signatureKey: signature_key })) {
    console.warn(`[Midtrans] Rejected notification for ${order_id}: invalid signature`);
    return res.status(401).json({ error: 'Invalid signature' });
  }
  try {
    const order = await prisma.creditOrder.findUnique({ where: { midtransOrderId: order_id } });
    if (!order) return res.status(200).json({ message: 'Unknown order, ignored' });
    if (Number(gross_amount) !== order.priceRp) return res.status(400).json({ error: 'Amount mismatch' });

    const isPaid = (transaction_status === 'capture' || transaction_status === 'settlement') && fraud_status !== 'deny';
    const isFailed = ['deny', 'cancel', 'expire'].includes(transaction_status);

    if (isPaid) {
      const result = await prisma.creditOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'paid', paidAt: new Date() } });
      if (result.count > 0) {
        const newValue = await quotaService.applyPurchase(null, order.userId, order.productType, order.quotaAmount, `Midtrans order ${order.midtransOrderId}`);
        logAudit(order.userId, 'credit.midtrans_topup', `Midtrans payment settled for order ${order.midtransOrderId}: +${order.quotaAmount} ${order.productType}`);
        await quotaService.publishQuotaUpdated(order.userId, order.productType, newValue);
      }
    } else if (isFailed) {
      await prisma.creditOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed' } });
    }
    return res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('Midtrans webhook handling error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/credit-orders/:id/cancel', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const result = await prisma.creditOrder.updateMany({ where: { id: req.params.id, userId: req.user!.id, status: 'pending' }, data: { status: 'cancelled' } });
  if (result.count === 0) return res.status(400).json({ error: 'Order sudah tidak bisa dibatalkan (mungkin sudah dibayar atau kedaluwarsa)' });
  return res.json({ message: 'Order dibatalkan' });
});

app.get('/credit-orders/me', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const orders = await prisma.creditOrder.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50, include: { package: { select: { name: true, productType: true } } } });
  return res.json(orders);
});

// ---- Bundle packages ----

app.get('/bundle-packages', async (_req, res) => {
  const bundles = await prisma.bundlePackage.findMany({ where: { isActive: true }, include: { items: true }, orderBy: { priceRp: 'asc' } });
  return res.json(bundles);
});

app.get('/bundle-packages/admin', authenticateJWT, async (_req, res) => {
  const bundles = await prisma.bundlePackage.findMany({ include: { items: true }, orderBy: { priceRp: 'asc' } });
  return res.json(bundles);
});

const validateItems = (items: any): items is { productType: CreditProductType; quotaAmount: number }[] =>
  Array.isArray(items) && items.length > 0 && items.every((i) => i && VALID_PRODUCT_TYPES.includes(i.productType) && Number.isInteger(i.quotaAmount) && i.quotaAmount > 0);

app.post('/bundle-packages', authenticateJWT, async (req, res) => {
  const { name, description, priceRp, items } = req.body;
  if (!name || !priceRp || priceRp <= 0) return res.status(400).json({ error: 'Parameters "name" and "priceRp" (positive) are required' });
  if (!validateItems(items)) return res.status(400).json({ error: 'Parameter "items" must be a non-empty array of { productType, quotaAmount > 0 }' });
  const bundle = await prisma.bundlePackage.create({
    data: { name, description: description || null, priceRp, items: { create: items.map((i) => ({ productType: i.productType, quotaAmount: i.quotaAmount })) } },
    include: { items: true },
  });
  return res.status(201).json(bundle);
});

app.patch('/bundle-packages/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { name, description, priceRp, isActive, items } = req.body;
  if (items !== undefined && !validateItems(items)) return res.status(400).json({ error: 'Parameter "items" must be a non-empty array of { productType, quotaAmount > 0 }' });
  const bundle = await prisma.bundlePackage.findUnique({ where: { id } });
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  const updated = await prisma.$transaction(async (tx) => {
    if (items !== undefined) {
      await tx.bundleItem.deleteMany({ where: { bundlePackageId: id } });
      await tx.bundleItem.createMany({ data: items.map((i: any) => ({ bundlePackageId: id, productType: i.productType, quotaAmount: i.quotaAmount })) });
    }
    return tx.bundlePackage.update({ where: { id }, data: { name, description, priceRp, isActive }, include: { items: true } });
  });
  return res.json(updated);
});

app.delete('/bundle-packages/:id', authenticateJWT, async (req, res) => {
  const bundle = await prisma.bundlePackage.findUnique({ where: { id: req.params.id } });
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  await prisma.bundlePackage.update({ where: { id: req.params.id }, data: { isActive: false } });
  return res.json({ message: 'Bundle deactivated' });
});

// ---- Bundle orders (Midtrans) ----

app.post('/bundle-orders', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { bundleId } = req.body;
  if (!bundleId) return res.status(400).json({ error: 'Parameter "bundleId" is required' });
  try {
    const bundle = await prisma.bundlePackage.findFirst({ where: { id: bundleId, isActive: true }, include: { items: true } });
    if (!bundle) return res.status(404).json({ error: 'Bundle not found or no longer available' });
    const user = await getUser(req.user!.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const midtransOrderId = `BD-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const { token } = await midtransService.createSnapTransaction({ orderId: midtransOrderId, grossAmount: bundle.priceRp, customerName: user.name, customerEmail: user.email });
    const order = await prisma.bundleOrder.create({
      data: {
        userId: user.id, bundlePackageId: bundle.id, priceRp: bundle.priceRp, midtransOrderId, snapToken: token, status: 'pending',
        items: { create: bundle.items.map((i) => ({ productType: i.productType, quotaAmount: i.quotaAmount })) },
      },
    });
    return res.status(201).json({ token, orderId: order.midtransOrderId });
  } catch (err: any) {
    console.error('Create bundle order error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/midtrans/bundle-webhook', async (req, res) => {
  const { order_id, status_code, gross_amount, transaction_status, fraud_status, signature_key } = req.body;
  if (!order_id || !status_code || !gross_amount || !signature_key) return res.status(400).json({ error: 'Malformed notification payload' });
  if (!midtransService.verifySignature({ orderId: order_id, statusCode: status_code, grossAmount: gross_amount, signatureKey: signature_key })) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  try {
    const order = await prisma.bundleOrder.findUnique({ where: { midtransOrderId: order_id }, include: { items: true, bundlePackage: { select: { name: true } } } });
    if (!order) return res.status(200).json({ message: 'Unknown order, ignored' });
    if (Number(gross_amount) !== order.priceRp) return res.status(400).json({ error: 'Amount mismatch' });

    const isPaid = (transaction_status === 'capture' || transaction_status === 'settlement') && fraud_status !== 'deny';
    const isFailed = ['deny', 'cancel', 'expire'].includes(transaction_status);

    if (isPaid) {
      const result = await prisma.bundleOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'paid', paidAt: new Date() } });
      if (result.count > 0) {
        for (const item of order.items) {
          const newValue = await quotaService.applyPurchase(null, order.userId, item.productType, item.quotaAmount, `Midtrans bundle order ${order.midtransOrderId} (${order.bundlePackage.name})`);
          await quotaService.publishQuotaUpdated(order.userId, item.productType, newValue);
        }
        logAudit(order.userId, 'credit.midtrans_bundle_topup', `Midtrans bundle "${order.bundlePackage.name}" settled for order ${order.midtransOrderId}`);
      }
    } else if (isFailed) {
      await prisma.bundleOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed' } });
    }
    return res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('Midtrans bundle webhook handling error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/bundle-orders/:id/cancel', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const result = await prisma.bundleOrder.updateMany({ where: { id: req.params.id, userId: req.user!.id, status: 'pending' }, data: { status: 'cancelled' } });
  if (result.count === 0) return res.status(400).json({ error: 'Order sudah tidak bisa dibatalkan (mungkin sudah dibayar atau kedaluwarsa)' });
  return res.json({ message: 'Order dibatalkan' });
});

app.get('/bundle-orders/me', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const orders = await prisma.bundleOrder.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50, include: { bundlePackage: { select: { name: true } }, items: true } });
  return res.json(orders);
});

app.listen(PORT, () => console.log(`[billing] listening on ${PORT}`));
