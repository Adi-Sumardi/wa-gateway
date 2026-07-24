import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const topUp = async (adminId: string, userId: string, amount: number, note?: string): Promise<number> => {
  if (amount <= 0) {
    throw new Error('Top-up amount must be greater than zero');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { aiCreditBalance: { increment: amount } },
    });
    await tx.aiCreditTransaction.create({
      data: { userId, amount, balanceAfter: updated.aiCreditBalance, type: 'topup', note, createdBy: adminId },
    });
    return updated.aiCreditBalance;
  });
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
