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
  const { to, body, deviceId } = req.body;

  if (!to || !body) {
    return res.status(400).json({ error: 'Parameters "to" and "body" are required' });
  }

  try {
    // 1. Find the device to send from
    const authUser = (req as AuthenticatedRequest).user;
    if (!authUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let device;
    if (deviceId) {
      device = await prisma.device.findFirst({
        where: { id: deviceId, userId: authUser.id }
      });
    } else {
      // Find the first connected device belonging to this user
      device = await prisma.device.findFirst({
        where: { status: 'connected', userId: authUser.id },
      });
    }

    if (!device) {
      return res.status(400).json({ error: 'No active/connected device found to send message from' });
    }

    if (device.status !== 'connected') {
      return res.status(400).json({ error: `Selected device is in status: ${device.status}` });
    }

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

    // 4. Create Message record in database
    const msg = await prisma.message.create({
      data: {
        deviceId: device.id,
        contactId: contact.id,
        direction: 'outbound',
        content: body,
        status: 'queued',
      },
    });

    // 5. Send message command to Gateway via Socket.io
    const dispatched = sendWhatsappMessage({
      messageId: msg.id,
      deviceId: device.id,
      to: formattedRecipient,
      body,
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
      data: msg,
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
