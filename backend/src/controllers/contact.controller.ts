import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { logAudit } from '../services/audit.service';

const prisma = new PrismaClient();

export const listContacts = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const contacts = await prisma.contact.findMany({
      where: req.user.role === 'admin' ? {} : { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(contacts);
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
