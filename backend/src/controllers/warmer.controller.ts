import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import * as warmerService from '../services/warmer.service';

const prisma = new PrismaClient();

export const createWarmer = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { name, deviceIds, minIntervalMinutes, maxIntervalMinutes, activeHourStart, activeHourEnd, messagePool } = req.body;

  if (!name || !Array.isArray(deviceIds) || deviceIds.length < 2) {
    return res.status(400).json({ error: 'Parameters "name" and at least 2 "deviceIds" are required' });
  }

  try {
    const existingDevices = await prisma.device.findMany({
      where: authUser.role === 'admin' ? { id: { in: deviceIds } } : { id: { in: deviceIds }, userId: authUser.id },
    });
    if (existingDevices.length !== deviceIds.length) {
      return res.status(400).json({ error: 'One or more selected devices do not belong to you' });
    }

    const session = await prisma.warmerSession.create({
      data: {
        userId: authUser.id,
        name,
        minIntervalMinutes: minIntervalMinutes ?? 15,
        maxIntervalMinutes: maxIntervalMinutes ?? 45,
        activeHourStart: activeHourStart ?? 8,
        activeHourEnd: activeHourEnd ?? 22,
        messagePool: Array.isArray(messagePool) && messagePool.length > 0 ? messagePool : undefined,
        devices: { create: deviceIds.map((deviceId: string) => ({ deviceId })) },
      },
      include: { devices: { include: { device: { select: { id: true, label: true } } } } },
    });

    return res.status(201).json(session);
  } catch (err) {
    console.error('Create warmer error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const listWarmers = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sessions = await prisma.warmerSession.findMany({
      where: authUser.role === 'admin' ? {} : { userId: authUser.id },
      orderBy: { createdAt: 'desc' },
      include: {
        devices: { include: { device: { select: { id: true, label: true, status: true } } } },
        _count: { select: { logs: true } },
      },
    });
    return res.json(sessions);
  } catch (err) {
    console.error('List warmers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getWarmerLogs = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const session = await prisma.warmerSession.findFirst({
    where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: authUser.id },
  });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });

  const logs = await prisma.warmerLog.findMany({
    where: { warmerSessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return res.json(logs);
};

export const startWarmer = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const session = await prisma.warmerSession.findFirst({
    where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: authUser.id },
  });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });

  await warmerService.startWarmer(session.id);
  return res.json({ message: 'Warmer session started' });
};

export const pauseWarmer = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const session = await prisma.warmerSession.findFirst({
    where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: authUser.id },
  });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });

  await warmerService.pauseWarmer(session.id);
  return res.json({ message: 'Warmer session paused' });
};

export const deleteWarmer = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const session = await prisma.warmerSession.findFirst({
    where: authUser.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: authUser.id },
  });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });

  await warmerService.pauseWarmer(session.id).catch(() => undefined);
  await prisma.warmerSession.delete({ where: { id: session.id } });
  return res.json({ message: 'Warmer session deleted' });
};
