import { Response } from 'express';
import { CreditProductType, PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

const VALID_PRODUCT_TYPES: CreditProductType[] = ['ai_credit', 'broadcast_quota', 'warmer_slot'];

export const listPackages = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const packages = await prisma.creditPackage.findMany({
      where: req.user.role === 'admin' ? {} : { isActive: true },
      orderBy: [{ productType: 'asc' }, { quotaAmount: 'asc' }],
    });
    return res.json(packages);
  } catch (err) {
    console.error('List credit packages error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createPackage = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, productType, quotaAmount, priceRp } = req.body;

  if (!name || !quotaAmount || !priceRp || quotaAmount <= 0 || priceRp <= 0) {
    return res.status(400).json({ error: 'Parameters "name", "quotaAmount" and "priceRp" (all positive) are required' });
  }
  if (productType !== undefined && !VALID_PRODUCT_TYPES.includes(productType)) {
    return res.status(400).json({ error: 'Invalid productType' });
  }

  try {
    const pkg = await prisma.creditPackage.create({
      data: { name, productType: productType || 'ai_credit', quotaAmount, priceRp },
    });
    return res.status(201).json(pkg);
  } catch (err) {
    console.error('Create credit package error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updatePackage = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { name, quotaAmount, priceRp, isActive } = req.body;

  try {
    const pkg = await prisma.creditPackage.findUnique({ where: { id } });
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    const updated = await prisma.creditPackage.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        quotaAmount: quotaAmount !== undefined ? quotaAmount : undefined,
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

    // Only hard-delete if nothing references it yet - past orders have no
    // cascade, so deleting a referenced package would orphan order history.
    // Otherwise fall back to deactivating so it just stops appearing to
    // buyers without breaking anything that already points at it.
    const orderCount = await prisma.creditOrder.count({ where: { packageId: id } });
    if (orderCount === 0) {
      await prisma.creditPackage.delete({ where: { id } });
      return res.json({ message: 'Package deleted', deleted: true });
    }

    await prisma.creditPackage.update({ where: { id }, data: { isActive: false } });
    return res.json({
      message: `Package sudah pernah dibeli (${orderCount}x), tidak bisa dihapus permanen - dinonaktifkan sebagai gantinya`,
      deleted: false,
    });
  } catch (err) {
    console.error('Delete credit package error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
