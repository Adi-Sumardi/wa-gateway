import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { logAudit } from './audit';
import * as warmerService from './tick';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6010;
const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';
const BILLING_URL = process.env.BILLING_SERVICE_URL || 'http://billing:6009';

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'warmer' }));

app.post('/warmers', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { name, deviceIds, minIntervalMinutes, maxIntervalMinutes, activeHourStart, activeHourEnd, messagePool } = req.body;
  if (!name || !Array.isArray(deviceIds) || deviceIds.length < 2) {
    return res.status(400).json({ error: 'Parameters "name" and at least 2 "deviceIds" are required' });
  }
  try {
    const resp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices?ids=${deviceIds.join(',')}&ownerId=${req.user!.role === 'admin' ? '' : req.user!.id}`);
    const owned = resp.ok ? ((await resp.json()) as any[]) : [];
    if (owned.length !== deviceIds.length) return res.status(400).json({ error: 'One or more selected devices do not belong to you' });

    const session = await prisma.warmerSession.create({
      data: {
        userId: req.user!.id, name,
        minIntervalMinutes: minIntervalMinutes ?? 15, maxIntervalMinutes: maxIntervalMinutes ?? 45,
        activeHourStart: activeHourStart ?? 8, activeHourEnd: activeHourEnd ?? 22,
        messagePool: Array.isArray(messagePool) && messagePool.length > 0 ? messagePool : undefined,
        devices: { create: deviceIds.map((deviceId: string) => ({ deviceId })) },
      },
      include: { devices: true },
    });
    return res.status(201).json(session);
  } catch (err) {
    console.error('Create warmer error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/warmers', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const sessions = await prisma.warmerSession.findMany({
      where: req.user!.role === 'admin' ? {} : { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: { devices: true, _count: { select: { logs: true } } },
    });
    return res.json(sessions);
  } catch (err) {
    console.error('List warmers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/warmers/:id/logs', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const session = await prisma.warmerSession.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });
  const logs = await prisma.warmerLog.findMany({ where: { warmerSessionId: session.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  return res.json(logs);
});

app.post('/warmers/:id/start', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const session = await prisma.warmerSession.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });

  if (req.user!.role !== 'admin' && session.status !== 'active') {
    const [quotaResp, activeCount] = await Promise.all([
      fetch(`${BILLING_URL}/internal/quota/${req.user!.id}`),
      prisma.warmerSession.count({ where: { userId: req.user!.id, status: 'active' } }),
    ]);
    const quota = quotaResp.ok ? ((await quotaResp.json()) as any) : { maxWarmerSessions: 1 };
    const limit = quota.maxWarmerSessions ?? 1;
    if (activeCount >= limit) {
      return res.status(400).json({ error: `Batas maksimal ${limit} sesi warmer aktif bersamaan tercapai. Hentikan sesi lain atau beli slot tambahan.` });
    }
  }

  await warmerService.startWarmer(session.id);
  return res.json({ message: 'Warmer session started' });
});

app.post('/warmers/:id/pause', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const session = await prisma.warmerSession.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });
  await warmerService.pauseWarmer(session.id);
  return res.json({ message: 'Warmer session paused' });
});

app.delete('/warmers/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const session = await prisma.warmerSession.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!session) return res.status(404).json({ error: 'Warmer session not found' });
  await warmerService.pauseWarmer(session.id).catch(() => undefined);
  await prisma.warmerSession.delete({ where: { id: session.id } });
  logAudit(req.user!.id, 'warmer.delete', `Deleted warmer session "${session.name}"`);
  return res.json({ message: 'Warmer session deleted' });
});

// Internal - messaging-service forwards here when a 'message-status' ack
// doesn't match any real outbound Message (i.e. it's device-to-device
// warmer chatter, which messaging-service has no knowledge of).
app.patch('/internal/warmer-logs/:id/status', async (req, res) => {
  const { status, failedReason } = req.body;
  const result = await prisma.warmerLog.updateMany({ where: { id: req.params.id, status: { not: 'read' } }, data: { status, failedReason: failedReason || null } });
  if (result.count === 0) return res.json({ updated: false });
  const log = await prisma.warmerLog.findUnique({ where: { id: req.params.id } });
  if (log) {
    const { publish } = await import('./_shared/events');
    publish('warmer.log.status', { userId: (await prisma.warmerSession.findUnique({ where: { id: log.warmerSessionId }, select: { userId: true } }))?.userId, id: log.id, status: log.status }).catch((err) => console.error(err));
  }
  return res.json({ updated: true });
});

app.listen(PORT, async () => {
  console.log(`[warmer] listening on ${PORT}`);
  await warmerService.resumeActiveWarmers();
});
