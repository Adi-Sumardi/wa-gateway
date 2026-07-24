import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import * as creditService from '../services/credit.service';
import { logAudit } from '../services/audit.service';

const prisma = new PrismaClient();

export const topUpCredit = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // Adding money to someone's balance is a financial operation - restrict to
  // admins regardless of the permission matrix, same pattern as device transfer.
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: only admins can top up AI credits' });
  }

  const { userId } = req.params;
  const { amount, note } = req.body;

  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Parameter "amount" must be a positive number' });
  }

  try {
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    const newBalance = await creditService.topUp(req.user.id, userId, amount, note);
    logAudit(req.user.id, 'credit.topup', `Topped up ${amount} AI credits for "${target.email}" (new balance: ${newBalance})`);

    return res.json({ aiCreditBalance: newBalance });
  } catch (err: any) {
    console.error('Top up credit error:', err);
    return res.status(400).json({ error: err.message || 'Internal server error' });
  }
};

export const getTransactions = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { userId } = req.params;

  if (req.user.role !== 'admin' && userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const transactions = await prisma.aiCreditTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json(transactions);
  } catch (err) {
    console.error('Get credit transactions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
