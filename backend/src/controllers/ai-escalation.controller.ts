import { Response } from 'express';
import { EscalationStatus, PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

const VALID_STATUSES: EscalationStatus[] = ['open', 'resolved'];

export const listEscalations = async (req: AuthenticatedRequest, res: Response) => {
  const { status, deviceId } = req.query;
  try {
    const where: any = req.user!.role === 'admin' ? {} : { userId: req.user!.id };
    if (status && VALID_STATUSES.includes(status as EscalationStatus)) {
      where.status = status;
    }
    if (deviceId) {
      where.deviceId = deviceId;
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const [escalations, total] = await Promise.all([
      prisma.aiEscalation.findMany({
        where,
        include: {
          device: { select: { label: true } },
          contact: { select: { name: true, phoneNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.aiEscalation.count({ where }),
    ]);

    return res.json({ escalations, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error('List AI escalations error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const resolveEscalation = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    const where = req.user!.role === 'admin' ? { id } : { id, userId: req.user!.id };
    const result = await prisma.aiEscalation.updateMany({
      where: { ...where, status: 'open' },
      data: { status: 'resolved', resolvedBy: req.user!.id, resolvedAt: new Date() },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Escalation not found or already resolved' });
    }

    const escalation = await prisma.aiEscalation.findUnique({ where: { id } });
    return res.json(escalation);
  } catch (err) {
    console.error('Resolve AI escalation error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
