import { Response } from 'express';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getGrantedKeys } from '../services/permission.service';
import { logAudit } from '../services/audit.service';

const prisma = new PrismaClient();

const USER_SELECT = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true };

export const listUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: USER_SELECT,
    });
    return res.json(users);
  } catch (err) {
    console.error('List users error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createUser = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (role && !['admin', 'operator', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, passwordHash, role: role || 'operator' },
      select: USER_SELECT,
    });

    logAudit(req.user.id, 'user.create', `Created user "${user.email}" with role ${user.role}`);
    return res.status(201).json(user);
  } catch (err) {
    console.error('Create user error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateUser = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { name, email, password, role, isActive } = req.body;

  if (role && !['admin', 'operator', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (password !== undefined && password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (email !== undefined && email !== target.email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    const losingAdmin = target.role === 'admin' && ((role && role !== 'admin') || isActive === false);
    if (losingAdmin) {
      const otherActiveAdmins = await prisma.user.count({
        where: { role: 'admin', isActive: true, id: { not: id } },
      });
      if (otherActiveAdmins === 0) {
        return res.status(400).json({ error: 'Cannot remove the last active admin' });
      }
    }

    const passwordHash = password !== undefined ? await bcrypt.hash(password, 10) : undefined;

    const updated = await prisma.user.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        email: email !== undefined ? email : undefined,
        passwordHash,
        role: role !== undefined ? role : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
      },
      select: USER_SELECT,
    });

    if (email !== undefined || password !== undefined) {
      logAudit(req.user.id, 'user.credentials', `Updated credentials for user "${target.email}"${email !== undefined ? ` (new email: ${email})` : ''}`);
    }

    if (role !== undefined || isActive !== undefined) {
      logAudit(
        req.user.id,
        'user.update',
        `Updated user "${target.email}"${role !== undefined ? ` role -> ${role}` : ''}${isActive !== undefined ? ` isActive -> ${isActive}` : ''}`
      );
    }
    return res.json(updated);
  } catch (err) {
    console.error('Update user error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getPermissionMatrix = async (req: AuthenticatedRequest, res: Response) => {
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
      grants: Object.fromEntries(
        roles.map((role) => [role, role === 'admin' ? true : !!grantMap.get(`${role}:${p.key}`)])
      ),
    }));

    return res.json(matrix);
  } catch (err) {
    console.error('Get permission matrix error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updatePermissionMatrix = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { updates } = req.body as { updates: { role: Role; permissionKey: string; granted: boolean }[] };

  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: '"updates" array is required' });
  }

  try {
    await Promise.all(
      updates
        // Admin permissions are always fully granted; ignore any attempt to change them
        // so a UI bug or bad request can never lock every admin out of the app.
        .filter((u) => u.role !== 'admin')
        .map((u) =>
          prisma.rolePermission.upsert({
            where: { role_permissionKey: { role: u.role, permissionKey: u.permissionKey } },
            update: { granted: u.granted },
            create: { role: u.role, permissionKey: u.permissionKey, granted: u.granted },
          })
        )
    );

    logAudit(req.user.id, 'permissions.update', `Updated ${updates.filter((u) => u.role !== 'admin').length} permission grant(s)`);
    return res.json({ message: 'Permission matrix updated' });
  } catch (err) {
    console.error('Update permission matrix error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getAuditLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { name: true, email: true } } },
    });
    return res.json(logs);
  } catch (err) {
    console.error('Get audit logs error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getMyPermissions = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const keys = await getGrantedKeys(req.user.role as Role);
    return res.json({ permissions: Array.from(keys) });
  } catch (err) {
    console.error('Get my permissions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
