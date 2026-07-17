import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

export const listTemplates = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const templates = await prisma.template.findMany({
      where: req.user.role === 'admin' ? {} : { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(templates);
  } catch (err) {
    console.error('List templates error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createTemplate = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, content, mediaUrl, mediaType } = req.body;

  if (!name || !content) {
    return res.status(400).json({ error: 'Parameters "name" and "content" are required' });
  }

  try {
    const template = await prisma.template.create({
      data: {
        userId: req.user.id,
        name,
        content,
        mediaUrl: mediaUrl || null,
        mediaType: mediaUrl ? (mediaType || 'document') : 'none',
      },
    });
    return res.status(201).json(template);
  } catch (err) {
    console.error('Create template error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateTemplate = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { name, content, mediaUrl, mediaType } = req.body;

  try {
    const template = await prisma.template.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const updated = await prisma.template.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        content: content !== undefined ? content : undefined,
        mediaUrl: mediaUrl !== undefined ? mediaUrl || null : undefined,
        mediaType: mediaType !== undefined ? mediaType : undefined,
      },
    });
    return res.json(updated);
  } catch (err) {
    console.error('Update template error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteTemplate = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const template = await prisma.template.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });

    await prisma.template.delete({ where: { id } });
    return res.json({ message: 'Template deleted successfully' });
  } catch (err) {
    console.error('Delete template error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
