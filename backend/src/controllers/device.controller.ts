import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { sendInitDevice, sendLogoutDevice } from '../socket';
import { logAudit } from '../services/audit.service';

const prisma = new PrismaClient();

export const listDevices = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const devices = await prisma.device.findMany({
      where: req.user.role === 'admin' ? {} : { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(devices);
  } catch (err) {
    console.error('List devices error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createDevice = async (req: AuthenticatedRequest, res: Response) => {
  const { label } = req.body;

  if (!label) {
    return res.status(400).json({ error: 'Device label is required' });
  }

  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const device = await prisma.device.create({
      data: {
        label,
        userId: req.user.id,
        status: 'disconnected',
      },
    });

    // Request gateway to initialize this device
    sendInitDevice(device.id);
    logAudit(req.user.id, 'device.create', `Created device "${device.label}"`);

    return res.status(201).json(device);
  } catch (err) {
    console.error('Create device error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const reconnectDevice = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const device = await prisma.device.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Trigger initialization on gateway
    const success = sendInitDevice(device.id);
    if (!success) {
      return res.status(503).json({ error: 'Gateway server not connected' });
    }

    // Update status to connecting
    const updated = await prisma.device.update({
      where: { id },
      data: { status: 'connecting' },
    });

    return res.json(updated);
  } catch (err) {
    console.error('Reconnect device error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteDevice = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const device = await prisma.device.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Ask gateway to logout/disconnect
    sendLogoutDevice(device.id);

    // Delete from DB
    await prisma.device.delete({ where: { id } });
    logAudit(req.user.id, 'device.delete', `Deleted device "${device.label}"`);

    return res.json({ message: 'Device deleted successfully' });
  } catch (err) {
    console.error('Delete device error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateDeviceAi = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { aiEnabled, aiContext, aiWebsiteUrl, aiBrochureUrl, aiPriceList } = req.body;

  if ([aiEnabled, aiContext, aiWebsiteUrl, aiBrochureUrl, aiPriceList].every((v) => v === undefined)) {
    return res.status(400).json({ error: 'At least one AI configuration field is required' });
  }

  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const device = await prisma.device.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updated = await prisma.device.update({
      where: { id },
      data: {
        aiEnabled: aiEnabled !== undefined ? aiEnabled : undefined,
        aiContext: aiContext !== undefined ? aiContext : undefined,
        aiWebsiteUrl: aiWebsiteUrl !== undefined ? (aiWebsiteUrl || null) : undefined,
        aiBrochureUrl: aiBrochureUrl !== undefined ? (aiBrochureUrl || null) : undefined,
        aiPriceList: aiPriceList !== undefined ? (aiPriceList || null) : undefined,
      },
    });

    return res.json(updated);
  } catch (err) {
    console.error('Update device AI error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const transferDevice = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { userId } = req.body;
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // Reassigning ownership across accounts is more sensitive than the usual
  // devices.manage permission (which only lets you manage your own/shared
  // devices) - restrict it to admins regardless of the permission matrix.
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: only admins can transfer device ownership' });
  }

  if (!userId) {
    return res.status(400).json({ error: 'Parameter "userId" is required' });
  }

  try {
    const device = await prisma.device.findUnique({ where: { id }, include: { user: { select: { email: true } } } });
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser || !targetUser.isActive) {
      return res.status(400).json({ error: 'Target user not found or inactive' });
    }

    const updated = await prisma.device.update({ where: { id }, data: { userId } });
    logAudit(
      req.user.id,
      'device.transfer',
      `Transferred device "${device.label}" from ${device.user.email} to ${targetUser.email}`
    );

    return res.json(updated);
  } catch (err) {
    console.error('Transfer device error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

