import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import * as midtransService from '../services/midtrans.service';
import * as creditService from '../services/credit.service';
import { logAudit } from '../services/audit.service';
import { emitToOwner } from '../socket';

const prisma = new PrismaClient();

export const createOrder = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { bundleId } = req.body;
  if (!bundleId) return res.status(400).json({ error: 'Parameter "bundleId" is required' });

  try {
    const bundle = await prisma.bundlePackage.findFirst({ where: { id: bundleId, isActive: true }, include: { items: true } });
    if (!bundle) return res.status(404).json({ error: 'Bundle not found or no longer available' });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const midtransOrderId = `BD-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const { token } = await midtransService.createSnapTransaction({
      orderId: midtransOrderId,
      grossAmount: bundle.priceRp,
      customerName: user.name,
      customerEmail: user.email,
    });

    const order = await prisma.bundleOrder.create({
      data: {
        userId: user.id,
        bundlePackageId: bundle.id,
        priceRp: bundle.priceRp,
        midtransOrderId,
        snapToken: token,
        status: 'pending',
        items: {
          create: bundle.items.map((i) => ({ productType: i.productType, quotaAmount: i.quotaAmount })),
        },
      },
    });

    return res.status(201).json({ token, orderId: order.midtransOrderId });
  } catch (err: any) {
    console.error('Create bundle order error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};

// Called by Midtrans directly (server-to-server) - no JWT, security is the
// signature check below. Separate endpoint from the credit-order webhook so
// the two purchase flows stay independent and either can be reconfigured in
// the Midtrans dashboard without touching the other.
export const handleWebhook = async (req: Request, res: Response) => {
  const { order_id, status_code, gross_amount, transaction_status, fraud_status, signature_key } = req.body;

  if (!order_id || !status_code || !gross_amount || !signature_key) {
    return res.status(400).json({ error: 'Malformed notification payload' });
  }

  const validSignature = midtransService.verifySignature({
    orderId: order_id,
    statusCode: status_code,
    grossAmount: gross_amount,
    signatureKey: signature_key,
  });
  if (!validSignature) {
    console.warn(`[Midtrans] Rejected bundle notification for ${order_id}: invalid signature`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const order = await prisma.bundleOrder.findUnique({
      where: { midtransOrderId: order_id },
      include: { items: true, bundlePackage: { select: { name: true } } },
    });
    if (!order) {
      console.warn(`[Midtrans] Bundle notification for unknown order ${order_id}`);
      return res.status(200).json({ message: 'Unknown order, ignored' });
    }

    if (Number(gross_amount) !== order.priceRp) {
      console.error(`[Midtrans] Bundle amount mismatch for ${order_id}: expected ${order.priceRp}, got ${gross_amount}`);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    const isPaid = (transaction_status === 'capture' || transaction_status === 'settlement') && fraud_status !== 'deny';
    const isFailed = ['deny', 'cancel', 'expire'].includes(transaction_status);

    if (isPaid) {
      const result = await prisma.bundleOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'paid', paidAt: new Date() },
      });

      if (result.count > 0) {
        for (const item of order.items) {
          const newValue = await creditService.applyPurchase(
            null,
            order.userId,
            item.productType,
            item.quotaAmount,
            `Midtrans bundle order ${order.midtransOrderId} (${order.bundlePackage.name})`
          );
          emitToOwner(order.userId, 'quota-updated', { productType: item.productType, newValue });
        }
        logAudit(
          order.userId,
          'credit.midtrans_bundle_topup',
          `Midtrans bundle "${order.bundlePackage.name}" settled for order ${order.midtransOrderId}: ${order.items
            .map((i) => `+${i.quotaAmount} ${i.productType}`)
            .join(', ')}`
        );
      }
    } else if (isFailed) {
      await prisma.bundleOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'failed' },
      });
    }

    return res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('Midtrans bundle webhook handling error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const cancelOrder = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const result = await prisma.bundleOrder.updateMany({
      where: { id, userId: req.user.id, status: 'pending' },
      data: { status: 'cancelled' },
    });
    if (result.count === 0) {
      return res.status(400).json({ error: 'Order sudah tidak bisa dibatalkan (mungkin sudah dibayar atau kedaluwarsa)' });
    }
    return res.json({ message: 'Order dibatalkan' });
  } catch (err) {
    console.error('Cancel bundle order error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getMyOrders = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const orders = await prisma.bundleOrder.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { bundlePackage: { select: { name: true } }, items: true },
    });
    return res.json(orders);
  } catch (err) {
    console.error('Get my bundle orders error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
