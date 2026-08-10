import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { PrismaClient, Role } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { logAudit } from './audit';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6001;
const JWT_SECRET = process.env.JWT_SECRET || 'sendago-super-secret-jwt-key';

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'identity' }));

// ---- Auth ----

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Email tidak terdaftar' });
    if (!user.isActive) return res.status(401).json({ error: 'Akun ini telah dinonaktifkan. Hubungi admin Anda.' });
    if (!(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Password yang Anda masukkan salah' });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nama, email, dan password wajib diisi' });
  if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  try {
    if (await prisma.user.findUnique({ where: { email } })) {
      return res.status(409).json({ error: 'Email sudah terdaftar, silakan login' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { name, email, passwordHash, role: 'operator', isActive: true } });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Core identity fields only - quota/credit fields (aiCreditBalance,
// maxDevices, broadcastQuotaMonthly, maxWarmerSessions, ...) now live in
// billing-service/device-gateway/warmer-service. api-gateway's /auth/me
// composes this with those services' responses for the frontend.
app.get('/auth/me', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    console.error('Me query error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Users (admin) ----

const USER_SELECT = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true };

app.get('/users', authenticateJWT, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: USER_SELECT });
    return res.json(users);
  } catch (err) {
    console.error('List users error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/users', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
  if (role && !['admin', 'operator', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    if (await prisma.user.findUnique({ where: { email } })) return res.status(400).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { name, email, passwordHash, role: role || 'operator' }, select: USER_SELECT });
    logAudit(req.user!.id, 'user.create', `Created user "${user.email}" with role ${user.role}`);
    return res.status(201).json(user);
  } catch (err) {
    console.error('Create user error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/users/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const { name, email, password, role, isActive } = req.body;
  if (role && !['admin', 'operator', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password !== undefined && password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (email !== undefined && email !== target.email && (await prisma.user.findUnique({ where: { email } }))) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    if (id === req.user!.id && ((role !== undefined && role !== target.role) || isActive === false)) {
      return res.status(400).json({ error: 'You cannot change your own role or deactivate your own account. Ask another admin to do it.' });
    }
    const losingAdmin = target.role === 'admin' && ((role && role !== 'admin') || isActive === false);
    if (losingAdmin) {
      const otherActiveAdmins = await prisma.user.count({ where: { role: 'admin', isActive: true, id: { not: id } } });
      if (otherActiveAdmins === 0) return res.status(400).json({ error: 'Cannot remove the last active admin' });
    }

    const passwordHash = password !== undefined ? await bcrypt.hash(password, 10) : undefined;
    const updated = await prisma.user.update({
      where: { id },
      data: { name, email, passwordHash, role, isActive },
      select: USER_SELECT,
    });

    if (email !== undefined || password !== undefined) {
      logAudit(req.user!.id, 'user.credentials', `Updated credentials for user "${target.email}"`);
    }
    if (role !== undefined || isActive !== undefined) {
      logAudit(req.user!.id, 'user.update', `Updated user "${target.email}"${role !== undefined ? ` role -> ${role}` : ''}${isActive !== undefined ? ` isActive -> ${isActive}` : ''}`);
    }
    return res.json(updated);
  } catch (err) {
    console.error('Update user error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Internal - other services resolve {id -> role/isActive} to decide credit
// metering (admin bypass) without needing their own copy of the users table.
app.get('/internal/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true, isActive: true, name: true, email: true } });
  if (!user) return res.status(404).json({ error: 'Not found' });
  return res.json(user);
});

// ---- Permissions ----

app.get('/permissions/me', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const grants = await prisma.rolePermission.findMany({ where: { role: req.user!.role as Role, granted: true } });
    const keys = req.user!.role === 'admin'
      ? (await prisma.permission.findMany()).map((p) => p.key)
      : grants.map((g) => g.permissionKey);
    return res.json({ permissions: keys });
  } catch (err) {
    console.error('Get my permissions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/permissions', authenticateJWT, async (_req, res) => {
  try {
    const [permissions, grants] = await Promise.all([
      prisma.permission.findMany({ orderBy: [{ category: 'asc' }, { key: 'asc' }] }),
      prisma.rolePermission.findMany(),
    ]);
    const grantMap = new Map<string, boolean>();
    grants.forEach((g) => grantMap.set(`${g.role}:${g.permissionKey}`, g.granted));
    const roles: Role[] = ['admin', 'operator', 'viewer'];
    const matrix = permissions.map((p) => ({
      key: p.key,
      label: p.label,
      category: p.category,
      grants: Object.fromEntries(roles.map((role) => [role, role === 'admin' ? true : !!grantMap.get(`${role}:${p.key}`)])),
    }));
    return res.json(matrix);
  } catch (err) {
    console.error('Get permission matrix error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/permissions', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { updates } = req.body as { updates: { role: Role; permissionKey: string; granted: boolean }[] };
  if (!Array.isArray(updates)) return res.status(400).json({ error: '"updates" array is required' });
  try {
    await Promise.all(
      updates.filter((u) => u.role !== 'admin').map((u) =>
        prisma.rolePermission.upsert({
          where: { role_permissionKey: { role: u.role, permissionKey: u.permissionKey } },
          update: { granted: u.granted },
          create: { role: u.role, permissionKey: u.permissionKey, granted: u.granted },
        })
      )
    );
    logAudit(req.user!.id, 'permissions.update', `Updated ${updates.filter((u) => u.role !== 'admin').length} permission grant(s)`);
    return res.json({ message: 'Permission matrix updated' });
  } catch (err) {
    console.error('Update permission matrix error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Internal - called by every other service's requirePermission() middleware.
app.get('/internal/permissions/check', async (req, res) => {
  const role = req.query.role as Role;
  const key = req.query.key as string;
  if (!role || !key) return res.status(400).json({ error: 'role and key are required' });
  if (role === 'admin') return res.json({ granted: true });
  const grant = await prisma.rolePermission.findUnique({ where: { role_permissionKey: { role, permissionKey: key } } });
  return res.json({ granted: !!grant?.granted });
});

// ---- API Keys (personal integration credentials) ----

app.get('/apikeys', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, label: true, isActive: true, lastUsedAt: true, createdAt: true, plainKey: true },
    });
    return res.json(keys);
  } catch (err) {
    console.error('List API keys error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/apikeys', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: 'API key label is required' });
  try {
    const rawKey = 'sg_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyRecord = await prisma.apiKey.create({
      data: { userId: req.user!.id, label, keyHash, plainKey: rawKey, isActive: true },
    });
    logAudit(req.user!.id, 'apikey.create', `Created API key "${label}"`);
    return res.status(201).json({
      message: 'API Key generated successfully. Please copy it now as it will not be shown again.',
      apiKey: rawKey,
      data: { id: keyRecord.id, label: keyRecord.label, isActive: keyRecord.isActive, createdAt: keyRecord.createdAt },
    });
  } catch (err) {
    console.error('Create API key error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/apikeys/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  try {
    const key = await prisma.apiKey.findFirst({ where: req.user!.role === 'admin' ? { id } : { id, userId: req.user!.id } });
    if (!key) return res.status(404).json({ error: 'API key not found' });
    await prisma.apiKey.delete({ where: { id } });
    logAudit(req.user!.id, 'apikey.delete', `Revoked API key "${key.label}"`);
    return res.json({ message: 'API Key revoked and deleted successfully' });
  } catch (err) {
    console.error('Delete API key error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Internal - api-gateway calls this to authenticate X-API-KEY requests
// (the public send API) without holding the api_keys table itself.
app.get('/internal/apikeys/validate', async (req, res) => {
  const rawKey = req.query.key as string;
  if (!rawKey) return res.status(400).json({ error: 'key is required' });
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyRecord = await prisma.apiKey.findUnique({ where: { keyHash }, include: { user: true } });
  if (!keyRecord || !keyRecord.isActive || !keyRecord.user.isActive) {
    return res.status(401).json({ error: 'Invalid or inactive API Key' });
  }
  prisma.apiKey.update({ where: { id: keyRecord.id }, data: { lastUsedAt: new Date() } }).catch((err) => console.error('lastUsedAt update failed:', err));
  return res.json({ id: keyRecord.user.id, email: keyRecord.user.email, role: keyRecord.user.role });
});

app.listen(PORT, () => console.log(`[identity] listening on ${PORT}`));
