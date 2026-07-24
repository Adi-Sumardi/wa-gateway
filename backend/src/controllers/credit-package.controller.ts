import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

export const listPackages = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const packages = await prisma.creditPackage.findMany({
      where: req.user.role === 'admin' ? {} : { isActive: true },
      orderBy: { coins: 'asc' },
    });
    return res.json(packages);
  } catch (err) {
    console.error('List credit packages error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createPackage = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, coins, priceRp } = req.body;

  if (!name || !coins || !priceRp || coins <= 0 || priceRp <= 0) {
    return res.status(400).json({ error: 'Parameters "name", "coins" and "priceRp" (all positive) are required' });
  }

  try {
    const pkg = await prisma.creditPackage.create({ data: { name, coins, priceRp } });
    return res.status(201).json(pkg);
  } catch (err) {
    console.error('Create credit package error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updatePackage = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { name, coins, priceRp, isActive } = req.body;

  try {
    const pkg = await prisma.creditPackage.findUnique({ where: { id } });
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    const updated = await prisma.creditPackage.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        coins: coins !== undefined ? coins : undefined,
        priceRp: priceRp !== undefined ? priceRp : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
      },
    });
    return res.json(updated);
  } catch (err) {
    console.error('Update credit package error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deletePackage = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const pkg = await prisma.creditPackage.findUnique({ where: { id } });
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    // Past orders reference this package (no cascade) - deactivate instead
    // of hard-deleting so order history stays intact.
    await prisma.creditPackage.update({ where: { id }, data: { isActive: false } });
    return res.json({ message: 'Package deactivated' });
  } catch (err) {
    console.error('Delete credit package error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
