import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import * as broadcastService from '../services/broadcast.service';
import { logAudit } from '../services/audit.service';

const prisma = new PrismaClient();

export const createBroadcast = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const {
    name, content, mediaUrl, deviceId, rotateDevices, phoneNumbers,
    delayMinSeconds, delayMaxSeconds, sleepEnabled, sleepStart, sleepEnd, scheduledAt, templateId,
  } = req.body;

  if (!name || (!content && !templateId) || !deviceId || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ error: 'Parameters "name", "content" (or "templateId"), "deviceId" and a non-empty "phoneNumbers" array are required' });
  }

  try {
    // Monthly broadcast quota - admin is unlimited. This is a conservative
    // pre-check using the raw pasted count (before the service's own
    // dedup/opt-out filtering), so it can never let someone exceed quota;
    // the real deduped count is used to increment usage below.
    if (authUser.role !== 'admin') {
      const owner = await prisma.user.findUnique({
        where: { id: authUser.id },
        select: { broadcastQuotaMonthly: true, broadcastSentThisMonth: true },
      });
      const remaining = (owner?.broadcastQuotaMonthly ?? 0) - (owner?.broadcastSentThisMonth ?? 0);
      if (phoneNumbers.length > remaining) {
        return res.status(400).json({ error: `Kuota broadcast bulan ini tidak cukup. Sisa kuota: ${Math.max(remaining, 0)} pesan.` });
      }
    }

    const broadcast = await broadcastService.createBroadcast({
      userId: authUser.id,
      isAdmin: authUser.role === 'admin',
      name,
      content,
      mediaUrl,
      deviceId,
      rotateDevices: !!rotateDevices,
      phoneNumbers,
      delayMinSeconds,
      delayMaxSeconds,
      sleepEnabled,
      sleepStart,
      sleepEnd,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
      templateId,
    });

    // Immediate send (no scheduledAt) starts right away.
    if (!scheduledAt) {
      await broadcastService.startBroadcast(broadcast.id);
    }

    if (authUser.role !== 'admin' && broadcast.targets.length > 0) {
      await prisma.user.update({
        where: { id: authUser.id },
        data: { broadcastSentThisMonth: { increment: broadcast.targets.length } },
      });
    }

    return res.status(201).json(broadcast);
  } catch (err: any) {
    console.error('Create broadcast error:', err);
    return res.status(400).json({ error: err.message || 'Failed to create broadcast' });
  }
};

export const listBroadcasts = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const broadcasts = await prisma.broadcast.findMany({
      where: authUser.role === 'admin' ? {} : { createdBy: authUser.id },
      orderBy: { createdAt: 'desc' },
      include: {
        device: { select: { label: true } },
        template: { select: { content: true, mediaUrl: true } },
        _count: { select: { targets: true } },
        targets: { select: { status: true } },
      },
    });

    const formatted = broadcasts.map((b) => {
      const sent = b.targets.filter((t) => t.status !== 'queued').length;
      const failed = b.targets.filter((t) => t.status === 'failed').length;
      return {
        id: b.id,
        name: b.name,
        status: b.status,
        deviceLabel: b.device.label,
        content: b.template?.content,
        mediaUrl: b.template?.mediaUrl,
        rotateDevices: b.rotateDevices,
        delayMinSeconds: b.delayMinSeconds,
        delayMaxSeconds: b.delayMaxSeconds,
        sleepEnabled: b.sleepEnabled,
        sleepStart: b.sleepStart,
        sleepEnd: b.sleepEnd,
        scheduledAt: b.scheduledAt,
        createdAt: b.createdAt,
        totalTargets: b._count.targets,
        sentTargets: sent,
        failedTargets: failed,
      };
    });

    return res.json(formatted);
  } catch (err) {
    console.error('List broadcasts error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getBroadcast = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const broadcast = await prisma.broadcast.findFirst({
      where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: authUser.id },
      include: {
        template: true,
        targets: { include: { contact: { select: { name: true, phoneNumber: true } } } },
      },
    });
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
    return res.json(broadcast);
  } catch (err) {
    console.error('Get broadcast error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const startBroadcast = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const broadcast = await prisma.broadcast.findFirst({
    where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: authUser.id },
  });
  if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });

  await broadcastService.startBroadcast(broadcast.id);
  return res.json({ message: 'Broadcast started' });
};

export const pauseBroadcast = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const broadcast = await prisma.broadcast.findFirst({
    where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: authUser.id },
  });
  if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });

  await broadcastService.pauseBroadcast(broadcast.id);
  return res.json({ message: 'Broadcast paused' });
};

export const deleteBroadcast = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const broadcast = await prisma.broadcast.findFirst({
    where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: authUser.id },
  });
  if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });

  await broadcastService.pauseBroadcast(broadcast.id).catch(() => undefined);
  await prisma.broadcast.delete({ where: { id: broadcast.id } });
  logAudit(authUser.id, 'broadcast.delete', `Deleted broadcast "${broadcast.name}"`);
  return res.json({ message: 'Broadcast deleted' });
};
