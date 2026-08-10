import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { logAudit } from './audit';
import { initGatewaySocket, sendInitDevice, sendLogoutDevice, sendWhatsappMessage } from './gatewaySocket';

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 6002;
const IDENTITY_URL = process.env.IDENTITY_SERVICE_URL || 'http://identity:6001';
const BILLING_URL = process.env.BILLING_SERVICE_URL || 'http://billing:6009';

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'device-gateway' }));

// ---- Devices (public REST) ----

app.get('/devices', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const devices = await prisma.device.findMany({ where: req.user!.role === 'admin' ? {} : { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
    const owners = await Promise.all(devices.map((d) => fetch(`${IDENTITY_URL}/internal/users/${d.userId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    const withOwner = devices.map((d, i) => ({ ...d, ownerName: (owners[i] as any)?.name, ownerEmail: (owners[i] as any)?.email }));
    return res.json(withOwner);
  } catch (err) {
    console.error('List devices error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/devices', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: 'Device label is required' });
  try {
    if (req.user!.role !== 'admin') {
      const [quotaResp, deviceCount] = await Promise.all([
        fetch(`${BILLING_URL}/internal/quota/${req.user!.id}`),
        prisma.device.count({ where: { userId: req.user!.id } }),
      ]);
      const quota = quotaResp.ok ? ((await quotaResp.json()) as any) : { maxDevices: 4 };
      const limit = quota.maxDevices ?? 4;
      if (deviceCount >= limit) return res.status(400).json({ error: `Batas maksimal ${limit} device tercapai. Hubungi admin untuk menambah slot.` });
    }
    const device = await prisma.device.create({ data: { label, userId: req.user!.id, status: 'disconnected' } });
    sendInitDevice(device.id);
    logAudit(req.user!.id, 'device.create', `Created device "${device.label}"`);
    return res.status(201).json(device);
  } catch (err) {
    console.error('Create device error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/devices/:id/reconnect', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const device = await prisma.device.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!sendInitDevice(device.id)) return res.status(503).json({ error: 'Gateway server not connected' });
  const updated = await prisma.device.update({ where: { id: device.id }, data: { status: 'connecting' } });
  return res.json(updated);
});

app.delete('/devices/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const device = await prisma.device.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!device) return res.status(404).json({ error: 'Device not found' });
  sendLogoutDevice(device.id);
  await prisma.device.delete({ where: { id: device.id } });
  logAudit(req.user!.id, 'device.delete', `Deleted device "${device.label}"`);
  return res.json({ message: 'Device deleted successfully' });
});

app.patch('/devices/:id/ai', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { aiEnabled, aiContext, aiWebsiteUrl, aiBrochureUrl, aiPriceList } = req.body;
  if ([aiEnabled, aiContext, aiWebsiteUrl, aiBrochureUrl, aiPriceList].every((v) => v === undefined)) {
    return res.status(400).json({ error: 'At least one AI configuration field is required' });
  }
  const device = await prisma.device.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: { aiEnabled, aiContext, aiWebsiteUrl: aiWebsiteUrl !== undefined ? aiWebsiteUrl || null : undefined, aiBrochureUrl: aiBrochureUrl !== undefined ? aiBrochureUrl || null : undefined, aiPriceList: aiPriceList !== undefined ? aiPriceList || null : undefined },
  });
  return res.json(updated);
});

app.patch('/devices/:id/transfer', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden: only admins can transfer device ownership' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Parameter "userId" is required' });
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const targetResp = await fetch(`${IDENTITY_URL}/internal/users/${userId}`);
  const targetUser = targetResp.ok ? ((await targetResp.json()) as any) : null;
  if (!targetUser || !targetUser.isActive) return res.status(400).json({ error: 'Target user not found or inactive' });
  const updated = await prisma.device.update({ where: { id: device.id }, data: { userId } });
  logAudit(req.user!.id, 'device.transfer', `Transferred device "${device.label}" to ${targetUser.email}`);
  return res.json(updated);
});

// ---- Internal (called by other services) ----

app.get('/internal/devices/:id', async (req, res) => {
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'Not found' });
  return res.json(device);
});

// Flexible lookup used by campaign/warmer: filter by ids and/or ownerId
// and/or status; pickRotating=true returns a single least-recently-used
// connected device for round-robin broadcast dispatch.
app.get('/internal/devices', async (req, res) => {
  const { ids, ownerId, status, pickRotating } = req.query as Record<string, string>;
  const where: any = {};
  if (ids) where.id = { in: ids.split(',').filter(Boolean) };
  if (ownerId) where.userId = ownerId;
  if (status) where.status = status;

  if (pickRotating === 'true') {
    const devices = await prisma.device.findMany({ where, orderBy: { lastConnectedAt: 'asc' } });
    if (devices.length === 0) return res.json(null);
    const picked = devices[0];
    await prisma.device.update({ where: { id: picked.id }, data: { lastConnectedAt: new Date() } });
    return res.json(picked);
  }
  const devices = await prisma.device.findMany({ where });
  return res.json(devices);
});

// Used by conversation-ai/campaign/warmer to actually push a message out
// through the WA worker's send queue.
app.post('/internal/devices/:id/send', async (req, res) => {
  const { messageId, to, body, mediaUrl } = req.body;
  const dispatched = sendWhatsappMessage({ messageId, deviceId: req.params.id, to, body, mediaUrl });
  return res.json({ dispatched });
});

initGatewaySocket(httpServer);
httpServer.listen(PORT, () => console.log(`[device-gateway] listening on ${PORT}`));
