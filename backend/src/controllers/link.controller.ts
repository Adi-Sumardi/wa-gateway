import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// Helper to generate a random short code (e.g. "a9b2c")
const generateShortCode = (length = 6): string => {
  return crypto.randomBytes(length).toString('hex').substring(0, length);
};

export const shortenUrl = async (req: AuthenticatedRequest, res: Response) => {
  const { originalUrl } = req.body;
  if (!originalUrl) {
    return res.status(400).json({ error: 'Parameter "originalUrl" is required' });
  }

  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let code = generateShortCode();
    // Ensure uniqueness
    let exists = await prisma.linkTracker.findUnique({ where: { code } });
    while (exists) {
      code = generateShortCode();
      exists = await prisma.linkTracker.findUnique({ where: { code } });
    }

    const link = await prisma.linkTracker.create({
      data: {
        userId: req.user.id,
        code,
        originalUrl,
      },
    });

    const host = req.headers.host || 'localhost:5001';
    const protocol = req.secure ? 'https' : 'http';
    const shortUrl = `${protocol}://${host}/l/${code}`;

    return res.status(201).json({
      message: 'Link shortened successfully',
      data: {
        id: link.id,
        code: link.code,
        originalUrl: link.originalUrl,
        shortUrl,
        clicks: link.clicks,
        createdAt: link.createdAt,
      },
    });
  } catch (err) {
    console.error('Shorten link error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const listLinks = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const links = await prisma.linkTracker.findMany({
      where: req.user.role === 'admin' ? {} : { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });

    const host = req.headers.host || 'localhost:5001';
    const protocol = req.secure ? 'https' : 'http';

    const formatted = links.map((l) => ({
      id: l.id,
      code: l.code,
      originalUrl: l.originalUrl,
      shortUrl: `${protocol}://${host}/l/${l.code}`,
      clicks: l.clicks,
      lastClickedAt: l.lastClickedAt,
      createdAt: l.createdAt,
    }));

    return res.json(formatted);
  } catch (err) {
    console.error('List shortened links error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const redirectUrl = async (req: Request, res: Response) => {
  const { code } = req.params;

  try {
    const link = await prisma.linkTracker.findUnique({
      where: { code },
    });

    if (!link) {
      return res.status(404).send('<h1>Link Not Found</h1><p>The shortened link you followed does not exist or has been deleted.</p>');
    }

    // Increment click count and update lastClickedAt in database
    await prisma.linkTracker.update({
      where: { id: link.id },
      data: {
        clicks: { increment: 1 },
        lastClickedAt: new Date(),
      },
    });

    // Perform HTTP redirect
    return res.redirect(link.originalUrl);
  } catch (err) {
    console.error('Redirect error:', err);
    return res.status(500).send('<h1>Server Error</h1><p>Failed to execute redirection. Please try again later.</p>');
  }
};
