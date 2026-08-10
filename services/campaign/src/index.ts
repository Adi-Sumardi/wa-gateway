import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as crypto from 'crypto';
import { LeadStatus, PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { logAudit } from './audit';
import * as dispatch from './dispatch';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6008;
const BILLING_URL = process.env.BILLING_SERVICE_URL || 'http://billing:6009';
const VALID_LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'converted', 'closed'];

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'campaign' }));

// ---- Broadcasts ----

app.post('/broadcasts', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { name, content, mediaUrl, deviceId, rotateDevices, phoneNumbers, delayMinSeconds, delayMaxSeconds, sleepEnabled, sleepStart, sleepEnd, scheduledAt, templateId } = req.body;
  if (!name || (!content && !templateId) || !deviceId || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ error: 'Parameters "name", "content" (or "templateId"), "deviceId" and a non-empty "phoneNumbers" array are required' });
  }
  try {
    if (req.user!.role !== 'admin') {
      const quotaResp = await fetch(`${BILLING_URL}/internal/quota/${req.user!.id}`);
      const quota = quotaResp.ok ? ((await quotaResp.json()) as any) : { broadcastQuotaMonthly: 0, broadcastSentThisMonth: 0 };
      const remaining = (quota.broadcastQuotaMonthly ?? 0) - (quota.broadcastSentThisMonth ?? 0);
      if (phoneNumbers.length > remaining) return res.status(400).json({ error: `Kuota broadcast bulan ini tidak cukup. Sisa kuota: ${Math.max(remaining, 0)} pesan.` });
    }

    const broadcast = await dispatch.createBroadcast({
      userId: req.user!.id, isAdmin: req.user!.role === 'admin', name, content, mediaUrl, deviceId,
      rotateDevices: !!rotateDevices, phoneNumbers, delayMinSeconds, delayMaxSeconds, sleepEnabled, sleepStart, sleepEnd,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined, templateId,
    });

    if (!scheduledAt) await dispatch.startBroadcast(broadcast.id);

    if (req.user!.role !== 'admin' && broadcast.targets.length > 0) {
      await fetch(`${BILLING_URL}/internal/quota/${req.user!.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcastSentThisMonthIncrement: broadcast.targets.length }),
      });
    }

    return res.status(201).json(broadcast);
  } catch (err: any) {
    console.error('Create broadcast error:', err);
    return res.status(400).json({ error: err.message || 'Failed to create broadcast' });
  }
});

app.get('/broadcasts', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const where = req.user!.role === 'admin' ? {} : { createdBy: req.user!.id };
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
  const [broadcasts, total] = await Promise.all([
    prisma.broadcast.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { targets: { select: { status: true } } } }),
    prisma.broadcast.count({ where }),
  ]);
  const formatted = broadcasts.map((b) => ({
    id: b.id, name: b.name, status: b.status, deviceId: b.deviceId, templateId: b.templateId,
    rotateDevices: b.rotateDevices, delayMinSeconds: b.delayMinSeconds, delayMaxSeconds: b.delayMaxSeconds,
    sleepEnabled: b.sleepEnabled, sleepStart: b.sleepStart, sleepEnd: b.sleepEnd, scheduledAt: b.scheduledAt, createdAt: b.createdAt,
    totalTargets: b.targets.length, sentTargets: b.targets.filter((t) => t.status !== 'queued').length, failedTargets: b.targets.filter((t) => t.status === 'failed').length,
  }));
  return res.json({ broadcasts: formatted, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

app.get('/broadcasts/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const broadcast = await prisma.broadcast.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: req.user!.id }, include: { targets: true } });
  if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
  return res.json(broadcast);
});

app.post('/broadcasts/:id/start', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const broadcast = await prisma.broadcast.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: req.user!.id } });
  if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
  await dispatch.startBroadcast(broadcast.id);
  return res.json({ message: 'Broadcast started' });
});

app.post('/broadcasts/:id/pause', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const broadcast = await prisma.broadcast.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: req.user!.id } });
  if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
  await dispatch.pauseBroadcast(broadcast.id);
  return res.json({ message: 'Broadcast paused' });
});

app.delete('/broadcasts/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const broadcast = await prisma.broadcast.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, createdBy: req.user!.id } });
  if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
  await dispatch.pauseBroadcast(broadcast.id).catch(() => undefined);
  await prisma.broadcast.delete({ where: { id: broadcast.id } });
  logAudit(req.user!.id, 'broadcast.delete', `Deleted broadcast "${broadcast.name}"`);
  return res.json({ message: 'Broadcast deleted' });
});

// Internal - messaging-service calls this when an outbound message tied to
// a broadcast gets a delivery ACK, so the target row + overall completion
// status stay in sync without campaign-service polling messaging's DB.
app.post('/internal/broadcast-targets/status', async (req, res) => {
  const { broadcastId, contactId, status, sentAt } = req.body;
  await prisma.broadcastTarget.updateMany({ where: { broadcastId, contactId }, data: { status, sentAt: sentAt ? new Date(sentAt) : undefined } });
  await dispatch.checkAndUpdateBroadcastStatus(broadcastId);
  return res.json({ ok: true });
});

// ---- Leads ----

app.post('/leads', async (req, res) => {
  const { name, phone, email, packageInterest, message } = req.body;
  if (!name || !phone || !packageInterest) return res.status(400).json({ error: 'Parameters "name", "phone" and "packageInterest" are required' });
  const lead = await prisma.lead.create({ data: { name, phone, email: email || null, packageInterest, message: message || null } });
  return res.status(201).json({ message: 'Terima kasih, tim kami akan segera menghubungi Anda.', id: lead.id });
});

app.get('/leads', authenticateJWT, async (req, res) => {
  const { status } = req.query;
  const where = status && VALID_LEAD_STATUSES.includes(status as LeadStatus) ? { status: status as LeadStatus } : {};
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
  const [leads, total] = await Promise.all([
    prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.lead.count({ where }),
  ]);
  return res.json({ leads, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

app.patch('/leads/:id', authenticateJWT, async (req, res) => {
  const { status, notes } = req.body;
  if (status !== undefined && !VALID_LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const updated = await prisma.lead.update({ where: { id: req.params.id }, data: { status, notes } });
  return res.json(updated);
});

// ---- Link shortener ----

const generateShortCode = (length = 6): string => crypto.randomBytes(length).toString('hex').substring(0, length);

app.post('/links/shorten', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { originalUrl } = req.body;
  if (!originalUrl) return res.status(400).json({ error: 'Parameter "originalUrl" is required' });
  let code = generateShortCode();
  while (await prisma.linkTracker.findUnique({ where: { code } })) code = generateShortCode();
  const link = await prisma.linkTracker.create({ data: { userId: req.user!.id, code, originalUrl } });
  const host = req.headers.host || 'localhost:6000';
  const protocol = req.secure ? 'https' : 'http';
  return res.status(201).json({ message: 'Link shortened successfully', data: { id: link.id, code: link.code, originalUrl: link.originalUrl, shortUrl: `${protocol}://${host}/l/${code}`, clicks: link.clicks, createdAt: link.createdAt } });
});

app.get('/links', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const links = await prisma.linkTracker.findMany({ where: req.user!.role === 'admin' ? {} : { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
  const host = req.headers.host || 'localhost:6000';
  const protocol = req.secure ? 'https' : 'http';
  return res.json(links.map((l) => ({ id: l.id, code: l.code, originalUrl: l.originalUrl, shortUrl: `${protocol}://${host}/l/${l.code}`, clicks: l.clicks, lastClickedAt: l.lastClickedAt, createdAt: l.createdAt })));
});

app.get('/l/:code', async (req, res) => {
  const link = await prisma.linkTracker.findUnique({ where: { code: req.params.code } });
  if (!link) return res.status(404).send('<h1>Link Not Found</h1><p>The shortened link you followed does not exist or has been deleted.</p>');
  await prisma.linkTracker.update({ where: { id: link.id }, data: { clicks: { increment: 1 }, lastClickedAt: new Date() } });
  return res.redirect(link.originalUrl);
});

app.listen(PORT, async () => {
  console.log(`[campaign] listening on ${PORT}`);
  await dispatch.resumeRunningBroadcasts();
});
