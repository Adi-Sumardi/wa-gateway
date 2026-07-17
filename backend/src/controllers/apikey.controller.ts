import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import * as crypto from 'crypto';
import { logAudit } from '../services/audit.service';

const prisma = new PrismaClient();

export const listKeys = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        plainKey: true,
      },
    });
    return res.json(keys);
  } catch (err) {
    console.error('List API keys error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createKey = async (req: AuthenticatedRequest, res: Response) => {
  const { label } = req.body;
  if (!label) {
    return res.status(400).json({ error: 'API key label is required' });
  }

  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Generate a secure API Key
    const rawKey = 'sg_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const keyRecord = await prisma.apiKey.create({
      data: {
        userId: req.user.id,
        label,
        keyHash,
        plainKey: rawKey,
        isActive: true,
      },
    });

    logAudit(req.user.id, 'apikey.create', `Created API key "${label}"`);

    // Return the rawKey only on creation so the user can copy it
    return res.status(201).json({
      message: 'API Key generated successfully. Please copy it now as it will not be shown again.',
      apiKey: rawKey,
      data: {
        id: keyRecord.id,
        label: keyRecord.label,
        isActive: keyRecord.isActive,
        createdAt: keyRecord.createdAt,
      },
    });
  } catch (err) {
    console.error('Create API key error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteKey = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // API keys are personal credentials, not team-shared: only the owner or an
    // admin can revoke a given key.
    const key = await prisma.apiKey.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await prisma.apiKey.delete({ where: { id } });
    logAudit(req.user.id, 'apikey.delete', `Revoked API key "${key.label}"`);
    return res.json({ message: 'API Key revoked and deleted successfully' });
  } catch (err) {
    console.error('Delete API key error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
