import { CreditProductType, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// actorId is the admin who manually topped someone up, or null for a
// system-initiated credit (e.g. a paid Midtrans order) - both paths share
// this one function so the ledger stays a single source of truth.
export const topUp = async (actorId: string | null, userId: string, amount: number, note?: string): Promise<number> => {
  if (amount <= 0) {
    throw new Error('Top-up amount must be greater than zero');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { aiCreditBalance: { increment: amount } },
    });
    await tx.aiCreditTransaction.create({
      data: { userId, amount, balanceAfter: updated.aiCreditBalance, type: 'topup', note, createdBy: actorId },
    });
    return updated.aiCreditBalance;
  });
};

// Single entry point for crediting a paid purchase of any product type -
// AI credit keeps its spend-tracked ledger (via topUp); broadcast quota and
// warmer slots are simple caps with no per-use ledger, just an increment.
export const applyPurchase = async (
  actorId: string | null,
  userId: string,
  productType: CreditProductType,
  quotaAmount: number,
  note?: string
): Promise<number> => {
  if (productType === 'ai_credit') {
    return topUp(actorId, userId, quotaAmount, note);
  }
  if (productType === 'broadcast_quota') {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { broadcastQuotaMonthly: { increment: quotaAmount } },
    });
    return updated.broadcastQuotaMonthly;
  }
  // warmer_slot
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { maxWarmerSessions: { increment: quotaAmount } },
  });
  return updated.maxWarmerSessions;
};

export const hasBalance = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { aiCreditBalance: true } });
  return !!user && user.aiCreditBalance > 0;
};

// Atomic decrement guarded in the WHERE clause (gte: 1) so two concurrent AI
// replies for the same user can never push the balance negative.
export const consumeCredit = async (userId: string): Promise<boolean> => {
  return prisma.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: { id: userId, aiCreditBalance: { gte: 1 } },
      data: { aiCreditBalance: { decrement: 1 } },
    });
    if (result.count === 0) return false;

    const user = await tx.user.findUnique({ where: { id: userId }, select: { aiCreditBalance: true } });
    await tx.aiCreditTransaction.create({
      data: { userId, amount: -1, balanceAfter: user?.aiCreditBalance ?? 0, type: 'consumption' },
    });
    return true;
  });
};
