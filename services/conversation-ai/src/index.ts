import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { EscalationStatus, PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { startEventSubscriptions } from './reply';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6004;
const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';
const CONTACT_URL = process.env.CONTACT_SERVICE_URL || 'http://contact:6006';
const VALID_STATUSES: EscalationStatus[] = ['open', 'resolved'];

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'conversation-ai' }));

app.get('/ai-escalations', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const where: any = req.user!.role === 'admin' ? {} : { userId: req.user!.id };
    if (req.query.status && VALID_STATUSES.includes(req.query.status as EscalationStatus)) where.status = req.query.status;
    if (req.query.deviceId) where.deviceId = req.query.deviceId;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const [escalations, total] = await Promise.all([
      prisma.aiEscalation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.aiEscalation.count({ where }),
    ]);

    const deviceIds = Array.from(new Set(escalations.map((e) => e.deviceId)));
    const contactIds = Array.from(new Set(escalations.map((e) => e.contactId)));
    const [devicesResp, contactsResp] = await Promise.all([
      fetch(`${DEVICE_GATEWAY_URL}/internal/devices?ids=${deviceIds.join(',')}`),
      fetch(`${CONTACT_URL}/internal/contacts?ids=${contactIds.join(',')}`),
    ]);
    const devices = devicesResp.ok ? ((await devicesResp.json()) as any[]) : [];
    const contacts = contactsResp.ok ? ((await contactsResp.json()) as any[]) : [];
    const deviceMap = new Map(devices.map((d) => [d.id, d]));
    const contactMap = new Map(contacts.map((c) => [c.id, c]));

    const enriched = escalations.map((e) => ({
      ...e,
      device: { label: deviceMap.get(e.deviceId)?.label },
      contact: { name: contactMap.get(e.contactId)?.name, phoneNumber: contactMap.get(e.contactId)?.phoneNumber },
    }));

    return res.json({ escalations: enriched, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error('List AI escalations error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/ai-escalations/:id/resolve', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const where = req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id };
    const result = await prisma.aiEscalation.updateMany({ where: { ...where, status: 'open' }, data: { status: 'resolved', resolvedBy: req.user!.id, resolvedAt: new Date() } });
    if (result.count === 0) return res.status(404).json({ error: 'Escalation not found or already resolved' });
    const escalation = await prisma.aiEscalation.findUnique({ where: { id: req.params.id } });
    return res.json(escalation);
  } catch (err) {
    console.error('Resolve AI escalation error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

startEventSubscriptions().catch((err) => console.error('[conversation-ai] failed to start event subscriptions:', err));

app.listen(PORT, () => console.log(`[conversation-ai] listening on ${PORT}`));
