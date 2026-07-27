import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { logAudit } from '../services/audit.service';

const prisma = new PrismaClient();

export const listContacts = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const where: any = req.user.role === 'admin' ? {} : { userId: req.user.id };
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phoneNumber: { contains: search } },
      ];
    }

    // ?all=true skips pagination - used by pickers (e.g. group membership)
    // that need every contact to select from, not just the current page.
    if (req.query.all === 'true') {
      const contacts = await prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' } });
      return res.json({ contacts, total: contacts.length, page: 1, limit: contacts.length, totalPages: 1 });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.contact.count({ where }),
    ]);

    return res.json({ contacts, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error('List contacts error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createContact = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, phoneNumber, tags, notes } = req.body;

  if (!name || !phoneNumber) {
    return res.status(400).json({ error: 'Parameters "name" and "phoneNumber" are required' });
  }

  try {
    const contact = await prisma.contact.create({
      data: {
        userId: req.user.id,
        name,
        phoneNumber,
        tags: Array.isArray(tags) ? tags : undefined,
        notes: notes || undefined,
      },
    });
    return res.status(201).json(contact);
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'A contact with this phone number already exists' });
    }
    console.error('Create contact error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateContact = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { name, tags, notes, optedOut } = req.body;

  try {
    const contact = await prisma.contact.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const updated = await prisma.contact.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        tags: tags !== undefined ? tags : undefined,
        notes: notes !== undefined ? notes : undefined,
        optedOut: optedOut !== undefined ? optedOut : undefined,
      },
    });
    return res.json(updated);
  } catch (err) {
    console.error('Update contact error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteContact = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const contact = await prisma.contact.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    await prisma.contact.delete({ where: { id } });
    logAudit(req.user.id, 'contact.delete', `Deleted contact "${contact.name}" (${contact.phoneNumber})`);
    return res.json({ message: 'Contact deleted successfully' });
  } catch (err) {
    console.error('Delete contact error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
