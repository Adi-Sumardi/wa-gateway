import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { publish } from './_shared/events';
import { startEventSubscriptions } from './events';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6003;
const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';
const CONTACT_URL = process.env.CONTACT_SERVICE_URL || 'http://contact:6006';

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'messaging' }));

export const formatPhoneNumber = (num: string): string => {
  let cleaned = num.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.substring(1);
  if (!cleaned.endsWith('@c.us')) cleaned = cleaned + '@c.us';
  return cleaned;
};

// Public send API (JWT or X-API-KEY, resolved to req.user by api-gateway).
app.post('/messages', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { to, body, deviceId, mediaUrl } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Parameters "to" and "body" are required' });

  try {
    const devicesResp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices?ownerId=${req.user!.id}&status=connected`);
    const connectedDevices = devicesResp.ok ? ((await devicesResp.json()) as any[]) : [];
    if (connectedDevices.length === 0) return res.status(400).json({ error: 'No active/connected device found to send message from. Please connect a device via scan QR first.' });

    let device = deviceId ? connectedDevices.find((d) => d.id === deviceId) : connectedDevices.sort((a, b) => new Date(a.lastConnectedAt || 0).getTime() - new Date(b.lastConnectedAt || 0).getTime())[0];
    if (!device) return res.status(400).json({ error: 'Selected device is not connected or does not belong to you' });

    const formattedRecipient = formatPhoneNumber(to);
    const standardNumberOnly = formattedRecipient.replace('@c.us', '');

    const contactResp = await fetch(`${CONTACT_URL}/internal/contacts/find-or-create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: req.user!.id, phoneNumber: standardNumberOnly }),
    });
    const contact = (await contactResp.json()) as { id: string };

    const msg = await prisma.message.create({ data: { deviceId: device.id, contactId: contact.id, direction: 'outbound', content: body, mediaUrl: mediaUrl || null, status: 'queued' } });

    const sendResp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${device.id}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: msg.id, to: formattedRecipient, body, mediaUrl }),
    });
    const dispatched = sendResp.ok && ((await sendResp.json()) as any).dispatched === true;

    if (!dispatched) {
      const failedMsg = await prisma.message.update({ where: { id: msg.id }, data: { status: 'failed', failedReason: 'Gateway engine is not connected to API server' } });
      return res.status(503).json({ error: 'Gateway engine is offline', message: failedMsg });
    }

    return res.status(202).json({ message: 'Message queued successfully', data: { id: msg.id, deviceId: msg.deviceId, deviceLabel: device.label, contactId: msg.contactId, content: msg.content, mediaUrl: msg.mediaUrl, status: msg.status, createdAt: msg.createdAt } });
  } catch (err) {
    console.error('Send message error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/messages', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    let deviceIds: string[] | undefined;
    if (req.user!.role !== 'admin') {
      const devicesResp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices?ownerId=${req.user!.id}`);
      const devices = devicesResp.ok ? ((await devicesResp.json()) as any[]) : [];
      deviceIds = devices.map((d) => d.id);
    }
    const where = deviceIds ? { deviceId: { in: deviceIds } } : {};
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 100));

    const [messages, total] = await Promise.all([
      prisma.message.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.message.count({ where }),
    ]);

    const uniqueDeviceIds = Array.from(new Set(messages.map((m) => m.deviceId)));
    const uniqueContactIds = Array.from(new Set(messages.map((m) => m.contactId)));
    const [devicesResp, contactsResp] = await Promise.all([
      fetch(`${DEVICE_GATEWAY_URL}/internal/devices?ids=${uniqueDeviceIds.join(',')}`),
      fetch(`${CONTACT_URL}/internal/contacts?ids=${uniqueContactIds.join(',')}`),
    ]);
    const devices = devicesResp.ok ? ((await devicesResp.json()) as any[]) : [];
    const contacts = contactsResp.ok ? ((await contactsResp.json()) as any[]) : [];
    const deviceMap = new Map(devices.map((d) => [d.id, d]));
    const contactMap = new Map(contacts.map((c) => [c.id, c]));

    const formatted = messages.map((m) => ({
      id: m.id, deviceId: m.deviceId, deviceLabel: deviceMap.get(m.deviceId)?.label,
      contactName: contactMap.get(m.contactId)?.name, contactPhone: contactMap.get(m.contactId)?.phoneNumber,
      direction: m.direction, content: m.content, status: m.status, failedReason: m.failedReason, createdAt: m.createdAt,
    }));
    return res.json({ messages: formatted, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error('Get messages logs error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Internal (called by conversation-ai, campaign) ----

app.post('/internal/messages', async (req, res) => {
  const { deviceId, contactId, broadcastId, direction, content, mediaUrl, status, userId } = req.body;
  const msg = await prisma.message.create({ data: { deviceId, contactId, broadcastId, direction, content, mediaUrl, status: status || 'queued' } });
  // Notifies notification-service for the live 'new-message' dashboard push,
  // same as the inbound path in events.ts - callers (conversation-ai,
  // campaign) don't need to publish this themselves.
  publish('message.persisted', { id: msg.id, deviceId: msg.deviceId, userId, contactId: msg.contactId, direction: msg.direction, content: msg.content, createdAt: msg.createdAt }).catch((err) => console.error('[messaging] publish failed:', err));
  return res.status(201).json(msg);
});

app.patch('/internal/messages/:id', async (req, res) => {
  const { status, failedReason } = req.body;
  const msg = await prisma.message.update({ where: { id: req.params.id }, data: { status, failedReason } });
  return res.json(msg);
});

startEventSubscriptions().catch((err) => console.error('[messaging] failed to start event subscriptions:', err));

app.listen(PORT, () => console.log(`[messaging] listening on ${PORT}`));
