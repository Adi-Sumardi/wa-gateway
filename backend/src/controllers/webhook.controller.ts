import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

export const listWebhooks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const webhooks = await prisma.webhook.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return res.json(webhooks);
  } catch (err) {
    console.error('List webhooks error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createWebhook = async (req: AuthenticatedRequest, res: Response) => {
  const { url, eventTypes } = req.body;

  if (!url || !eventTypes || !Array.isArray(eventTypes)) {
    return res.status(400).json({ error: 'url (string) and eventTypes (array of strings) are required' });
  }

  try {
    const webhook = await prisma.webhook.create({
      data: {
        url,
        eventTypes,
        isActive: true,
      },
    });
    return res.status(201).json(webhook);
  } catch (err) {
    console.error('Create webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteWebhook = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    await prisma.webhook.delete({ where: { id } });
    return res.json({ message: 'Webhook deleted successfully' });
  } catch (err) {
    console.error('Delete webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getWebhookLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const logs = await prisma.webhookLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        webhook: { select: { url: true } },
      },
    });
    return res.json(logs);
  } catch (err) {
    console.error('Get webhook logs error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
