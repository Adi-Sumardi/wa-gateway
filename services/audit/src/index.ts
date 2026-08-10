import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { subscribe } from './_shared/events';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6011;
const IDENTITY_URL = process.env.IDENTITY_SERVICE_URL || 'http://identity:6001';

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'audit' }));

// Every other service publishes here instead of writing a row directly -
// this is the one place the audit_logs table is written to.
subscribe('audit.logged', async (data: { userId: string; action: string; detail: string }) => {
  try {
    await prisma.auditLog.create({ data: { userId: data.userId, action: data.action, detail: data.detail } });
  } catch (err) {
    console.error('[audit] Failed to persist audit event:', err);
  }
}).catch((err) => console.error('[audit] failed to subscribe:', err));

app.get('/audit-logs', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.auditLog.count(),
    ]);
    const userIds = Array.from(new Set(logs.map((l) => l.userId)));
    const users = await Promise.all(userIds.map((id) => fetch(`${IDENTITY_URL}/internal/users/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    const userMap = new Map(userIds.map((id, i) => [id, users[i]]));
    const enriched = logs.map((l) => ({ ...l, user: userMap.get(l.userId) ? { name: (userMap.get(l.userId) as any).name, email: (userMap.get(l.userId) as any).email } : null }));
    return res.json({ logs: enriched, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error('Get audit logs error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => console.log(`[audit] listening on ${PORT}`));
