import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { sendWhatsappMessage } from '../socket';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

// Helper to format phone number to WA format (e.g. 628123456789@c.us)
export const formatPhoneNumber = (num: string): string => {
  let cleaned = num.replace(/\D/g, ''); // strip non-digits
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1); // convert local 08xx to country code 628xx
  }
  if (!cleaned.endsWith('@c.us')) {
    cleaned = cleaned + '@c.us';
  }
  return cleaned;
};

export const sendMessage = async (req: Request, res: Response) => {
  const { to, body, deviceId, mediaUrl, rotate } = req.body;

  if (!to || !body) {
    return res.status(400).json({ error: 'Parameters "to" and "body" are required' });
  }

  try {
    const authUser = (req as AuthenticatedRequest).user;
    if (!authUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 1. Fetch connected devices for round-robin rotation
    const connectedDevices = await prisma.device.findMany({
      where: { status: 'connected', userId: authUser.id },
      orderBy: { lastConnectedAt: 'asc' }, // oldest connected/used device comes first
    });

    if (connectedDevices.length === 0) {
      return res.status(400).json({ error: 'No active/connected device found to send message from. Please connect a device via scan QR first.' });
    }

    let device;
    if (deviceId) {
      // Find the specific device requested
      device = connectedDevices.find(d => d.id === deviceId);
      if (!device) {
        return res.status(400).json({ error: 'Selected device is not connected or does not belong to you' });
      }
    } else {
      // Rotate: Pick the device that was used longest ago (first in the list)
      device = connectedDevices[0];
    }

    // Update lastConnectedAt to shift this device to the end of the round-robin queue
    await prisma.device.update({
      where: { id: device.id },
      data: { lastConnectedAt: new Date() },
    });

    // 2. Format recipient number
    const formattedRecipient = formatPhoneNumber(to);
    const standardNumberOnly = formattedRecipient.replace('@c.us', '');

    // 3. Find or create Contact
    let contact = await prisma.contact.findUnique({
      where: { phoneNumber: standardNumberOnly },
    });

    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: standardNumberOnly,
          phoneNumber: standardNumberOnly,
        },
      });
    }

    // 4. Create Message record in database (with mediaUrl support)
    const msg = await prisma.message.create({
      data: {
        deviceId: device.id,
        contactId: contact.id,
        direction: 'outbound',
        content: body,
        mediaUrl: mediaUrl || null,
        status: 'queued',
      },
    });

    // 5. Send message command to Gateway via Socket.io
    const dispatched = sendWhatsappMessage({
      messageId: msg.id,
      deviceId: device.id,
      to: formattedRecipient,
      body,
      mediaUrl: mediaUrl || undefined,
    });

    if (!dispatched) {
      // If we couldn't dispatch to gateway, mark as failed
      const failedMsg = await prisma.message.update({
        where: { id: msg.id },
        data: {
          status: 'failed',
          failedReason: 'Gateway engine is not connected to API server',
        },
      });
      return res.status(503).json({ error: 'Gateway engine is offline', message: failedMsg });
    }

    return res.status(202).json({
      message: 'Message queued successfully',
      data: {
        id: msg.id,
        deviceId: msg.deviceId,
        deviceLabel: device.label,
        contactId: msg.contactId,
        content: msg.content,
        mediaUrl: msg.mediaUrl,
        status: msg.status,
        createdAt: msg.createdAt,
      },
    });
  } catch (err) {
    console.error('Send message error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getMessages = async (req: Request, res: Response) => {
  const authUser = (req as AuthenticatedRequest).user;
  if (!authUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const messages = await prisma.message.findMany({
      where: {
        device: {
          userId: authUser.id
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        device: { select: { label: true } },
        contact: { select: { name: true, phoneNumber: true } },
      },
    });

    // Format output to include contact name and phone number directly
    const formatted = messages.map(m => ({
      id: m.id,
      deviceId: m.deviceId,
      deviceLabel: m.device.label,
      contactName: m.contact.name,
      contactPhone: m.contact.phoneNumber,
      direction: m.direction,
      content: m.content,
      status: m.status,
      failedReason: m.failedReason,
      createdAt: m.createdAt,
    }));

    return res.json(formatted);
  } catch (err) {
    console.error('Get messages logs error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
