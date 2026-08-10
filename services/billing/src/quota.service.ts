import { CreditProductType, PrismaClient } from '@prisma/client';
import { publish } from './_shared/events';

const prisma = new PrismaClient();

// Every quota field lives on one row per user, created lazily on first touch
// (upsert) rather than provisioned eagerly when identity-service creates the
// user - billing doesn't get a "user created" call, it just meters usage.
const ensureQuotaRow = (userId: string) =>
  prisma.userQuota.upsert({ where: { userId }, update: {}, create: { userId } });

export const getQuota = async (userId: string) => ensureQuotaRow(userId);

export const topUpAiCredit = async (actorId: string | null, userId: string, amount: number, note?: string): Promise<number> => {
  if (amount <= 0) throw new Error('Top-up amount must be greater than zero');
  await ensureQuotaRow(userId);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.userQuota.update({ where: { userId }, data: { aiCreditBalance: { increment: amount } } });
    await tx.aiCreditTransaction.create({
      data: { userId, amount, balanceAfter: updated.aiCreditBalance, type: 'topup', note, createdBy: actorId },
    });
    return updated.aiCreditBalance;
  });
};

export const applyPurchase = async (
  actorId: string | null,
  userId: string,
  productType: CreditProductType,
  quotaAmount: number,
  note?: string
): Promise<number> => {
  if (productType === 'ai_credit') return topUpAiCredit(actorId, userId, quotaAmount, note);
  await ensureQuotaRow(userId);
  if (productType === 'broadcast_quota') {
    const updated = await prisma.userQuota.update({ where: { userId }, data: { broadcastQuotaMonthly: { increment: quotaAmount } } });
    return updated.broadcastQuotaMonthly;
  }
  const updated = await prisma.userQuota.update({ where: { userId }, data: { maxWarmerSessions: { increment: quotaAmount } } });
  return updated.maxWarmerSessions;
};

export const hasAiBalance = async (userId: string): Promise<boolean> => {
  const q = await prisma.userQuota.findUnique({ where: { userId } });
  return !!q && q.aiCreditBalance > 0;
};

// Atomic decrement guarded in the WHERE clause so concurrent AI replies for
// the same user can never push the balance negative.
export const consumeAiCredit = async (userId: string): Promise<number | null> => {
  return prisma.$transaction(async (tx) => {
    const result = await tx.userQuota.updateMany({ where: { userId, aiCreditBalance: { gte: 1 } }, data: { aiCreditBalance: { decrement: 1 } } });
    if (result.count === 0) return null;
    const q = await tx.userQuota.findUnique({ where: { userId } });
    const balanceAfter = q?.aiCreditBalance ?? 0;
    await tx.aiCreditTransaction.create({ data: { userId, amount: -1, balanceAfter, type: 'consumption' } });
    return balanceAfter;
  });
};

export const publishQuotaUpdated = (userId: string, productType: CreditProductType, newValue: number) =>
  publish('quota.updated', { userId, productType, newValue }).catch((err) => console.error('[billing] publish quota.updated failed:', err));
