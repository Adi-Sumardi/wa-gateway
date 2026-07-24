import { Response } from 'express';
import { CreditProductType, PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { Request } from 'express';

const prisma = new PrismaClient();

const VALID_PRODUCT_TYPES: CreditProductType[] = ['ai_credit', 'broadcast_quota', 'warmer_slot'];

interface BundleItemInput {
  productType: CreditProductType;
  quotaAmount: number;
}

const validateItems = (items: any): items is BundleItemInput[] => {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(
    (item) =>
      item &&
      VALID_PRODUCT_TYPES.includes(item.productType) &&
      Number.isInteger(item.quotaAmount) &&
      item.quotaAmount > 0
  );
};

// Public - used by the landing page, no auth required.
export const listPublicBundles = async (_req: Request, res: Response) => {
  try {
    const bundles = await prisma.bundlePackage.findMany({
      where: { isActive: true },
      include: { items: true },
      orderBy: { priceRp: 'asc' },
    });
    return res.json(bundles);
  } catch (err) {
    console.error('List public bundles error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const listAdminBundles = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const bundles = await prisma.bundlePackage.findMany({
      include: { items: true },
      orderBy: { priceRp: 'asc' },
    });
    return res.json(bundles);
  } catch (err) {
    console.error('List admin bundles error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createBundle = async (req: AuthenticatedRequest, res: Response) => {
  const { name, description, priceRp, items } = req.body;

  if (!name || !priceRp || priceRp <= 0) {
    return res.status(400).json({ error: 'Parameters "name" and "priceRp" (positive) are required' });
  }
  if (!validateItems(items)) {
    return res.status(400).json({ error: 'Parameter "items" must be a non-empty array of { productType, quotaAmount > 0 }' });
  }

  try {
    const bundle = await prisma.bundlePackage.create({
      data: {
        name,
        description: description || null,
        priceRp,
        items: { create: items.map((i) => ({ productType: i.productType, quotaAmount: i.quotaAmount })) },
      },
      include: { items: true },
    });
    return res.status(201).json(bundle);
  } catch (err) {
    console.error('Create bundle error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateBundle = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { name, description, priceRp, isActive, items } = req.body;

  if (items !== undefined && !validateItems(items)) {
    return res.status(400).json({ error: 'Parameter "items" must be a non-empty array of { productType, quotaAmount > 0 }' });
  }

  try {
    const bundle = await prisma.bundlePackage.findUnique({ where: { id } });
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const updated = await prisma.$transaction(async (tx) => {
      if (items !== undefined) {
        await tx.bundleItem.deleteMany({ where: { bundlePackageId: id } });
        await tx.bundleItem.createMany({
          data: items.map((i: BundleItemInput) => ({ bundlePackageId: id, productType: i.productType, quotaAmount: i.quotaAmount })),
        });
      }
      return tx.bundlePackage.update({
        where: { id },
        data: {
          name: name !== undefined ? name : undefined,
          description: description !== undefined ? description : undefined,
          priceRp: priceRp !== undefined ? priceRp : undefined,
          isActive: isActive !== undefined ? isActive : undefined,
        },
        include: { items: true },
      });
    });

    return res.json(updated);
  } catch (err) {
    console.error('Update bundle error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteBundle = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const bundle = await prisma.bundlePackage.findUnique({ where: { id } });
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    // Past orders reference this bundle (no cascade) - deactivate instead of
    // hard-deleting so order history stays intact.
    await prisma.bundlePackage.update({ where: { id }, data: { isActive: false } });
    return res.json({ message: 'Bundle deactivated' });
  } catch (err) {
    console.error('Delete bundle error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
