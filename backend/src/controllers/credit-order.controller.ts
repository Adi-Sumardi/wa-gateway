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
  const { packageId } = req.body;
  if (!packageId) return res.status(400).json({ error: 'Parameter "packageId" is required' });

  try {
    const pkg = await prisma.creditPackage.findFirst({ where: { id: packageId, isActive: true } });
    if (!pkg) return res.status(404).json({ error: 'Package not found or no longer available' });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const midtransOrderId = `CR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const { token } = await midtransService.createSnapTransaction({
      orderId: midtransOrderId,
      grossAmount: pkg.priceRp,
      customerName: user.name,
      customerEmail: user.email,
    });

    const order = await prisma.creditOrder.create({
      data: {
        userId: user.id,
        packageId: pkg.id,
        quotaAmount: pkg.quotaAmount,
        priceRp: pkg.priceRp,
        midtransOrderId,
        snapToken: token,
        status: 'pending',
      },
    });

    return res.status(201).json({ token, orderId: order.midtransOrderId });
  } catch (err: any) {
    console.error('Create credit order error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};

// Called by Midtrans directly (server-to-server) - no JWT, security is the
// signature check below. Always responds quickly since Midtrans expects a
// fast ack and will otherwise retry the notification.
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
    console.warn(`[Midtrans] Rejected notification for ${order_id}: invalid signature`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const order = await prisma.creditOrder.findUnique({
      where: { midtransOrderId: order_id },
      include: { package: true },
    });
    if (!order) {
      console.warn(`[Midtrans] Notification for unknown order ${order_id}`);
      return res.status(200).json({ message: 'Unknown order, ignored' });
    }

    // Defense against a tampered/mismatched notification - trust our own
    // stored price over whatever the payload claims.
    if (Number(gross_amount) !== order.priceRp) {
      console.error(`[Midtrans] Amount mismatch for ${order_id}: expected ${order.priceRp}, got ${gross_amount}`);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    const isPaid = (transaction_status === 'capture' || transaction_status === 'settlement') && fraud_status !== 'deny';
    const isFailed = ['deny', 'cancel', 'expire'].includes(transaction_status);

    if (isPaid) {
      // Atomic guard: only the first delivery of this notification (or a
      // retry that arrives concurrently) actually flips pending -> paid and
      // credits the balance - any duplicate redelivery becomes a no-op.
      const result = await prisma.creditOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'paid', paidAt: new Date() },
      });

      if (result.count > 0) {
        const newValue = await creditService.applyPurchase(
          null,
          order.userId,
          order.package.productType,
          order.quotaAmount,
          `Midtrans order ${order.midtransOrderId}`
        );
        logAudit(
          order.userId,
          'credit.midtrans_topup',
          `Midtrans payment settled for order ${order.midtransOrderId}: +${order.quotaAmount} ${order.package.productType}`
        );
        emitToOwner(order.userId, 'quota-updated', { productType: order.package.productType, newValue });
      }
    } else if (isFailed) {
      await prisma.creditOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'failed' },
      });
    }

    return res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('Midtrans webhook handling error:', err);
    // Still ack with 200 isn't appropriate here since we genuinely failed to
    // process it - let Midtrans retry.
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const cancelOrder = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    // Atomic guard: only actually cancels if it was still pending, so this
    // can't race a webhook that just settled the same order as paid.
    const result = await prisma.creditOrder.updateMany({
      where: { id, userId: req.user.id, status: 'pending' },
      data: { status: 'cancelled' },
    });
    if (result.count === 0) {
      return res.status(400).json({ error: 'Order sudah tidak bisa dibatalkan (mungkin sudah dibayar atau kedaluwarsa)' });
    }
    return res.json({ message: 'Order dibatalkan' });
  } catch (err) {
    console.error('Cancel credit order error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getMyOrders = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const orders = await prisma.creditOrder.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { package: { select: { name: true, productType: true } } },
    });
    return res.json(orders);
  } catch (err) {
    console.error('Get my credit orders error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
