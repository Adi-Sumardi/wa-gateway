import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { sendInitDevice, sendLogoutDevice } from '../socket';

const prisma = new PrismaClient();

export const listDevices = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const devices = await prisma.device.findMany({
      where: { userId: req.user.id },
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

    return res.status(201).json(device);
  } catch (err) {
    console.error('Create device error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const reconnectDevice = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const device = await prisma.device.findUnique({ where: { id } });
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

  try {
    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Ask gateway to logout/disconnect
    sendLogoutDevice(device.id);

    // Delete from DB
    await prisma.device.delete({ where: { id } });

    return res.json({ message: 'Device deleted successfully' });
  } catch (err) {
    console.error('Delete device error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
