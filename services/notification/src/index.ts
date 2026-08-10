import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { logAudit } from './audit';
import { initDashboardSocket } from './dashboardSocket';
import { startEventSubscriptions } from './events';

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 6005;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notification' }));

app.get('/webhooks', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const webhooks = await prisma.webhook.findMany({ where: req.user!.role === 'admin' ? {} : { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
  return res.json(webhooks);
});

app.post('/webhooks', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { url, eventTypes } = req.body;
  if (!url || !eventTypes || !Array.isArray(eventTypes)) return res.status(400).json({ error: 'url (string) and eventTypes (array of strings) are required' });
  const webhook = await prisma.webhook.create({ data: { userId: req.user!.id, url, eventTypes, isActive: true } });
  logAudit(req.user!.id, 'webhook.create', `Created webhook for ${url}`);
  return res.status(201).json(webhook);
});

app.delete('/webhooks/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const webhook = await prisma.webhook.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
  await prisma.webhook.delete({ where: { id: webhook.id } });
  logAudit(req.user!.id, 'webhook.delete', `Deleted webhook for ${webhook.url}`);
  return res.json({ message: 'Webhook deleted successfully' });
});

app.get('/webhooks/logs', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const logs = await prisma.webhookLog.findMany({
    where: req.user!.role === 'admin' ? {} : { webhook: { userId: req.user!.id } },
    orderBy: { createdAt: 'desc' }, take: 100, include: { webhook: { select: { url: true } } },
  });
  return res.json(logs);
});

initDashboardSocket(httpServer);
startEventSubscriptions().catch((err) => console.error('[notification] failed to start event subscriptions:', err));

httpServer.listen(PORT, () => console.log(`[notification] listening on ${PORT}`));
