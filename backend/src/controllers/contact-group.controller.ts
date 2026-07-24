import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

export const listGroups = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const groups = await prisma.contactGroup.findMany({
      where: req.user.role === 'admin' ? {} : { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { members: true } }, members: { select: { contactId: true } } },
    });
    return res.json(groups.map((g) => ({ ...g, memberContactIds: g.members.map((m) => m.contactId), members: undefined })));
  } catch (err) {
    console.error('List contact groups error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createGroup = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Parameter "name" is required' });

  try {
    const group = await prisma.contactGroup.create({
      data: { userId: req.user.id, name, description: description || undefined },
    });
    return res.status(201).json(group);
  } catch (err) {
    console.error('Create contact group error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteGroup = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const group = await prisma.contactGroup.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    await prisma.contactGroup.delete({ where: { id } });
    return res.json({ message: 'Group deleted successfully' });
  } catch (err) {
    console.error('Delete contact group error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const setGroupMembers = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { contactIds } = req.body as { contactIds: string[] };

  if (!Array.isArray(contactIds)) {
    return res.status(400).json({ error: '"contactIds" array is required' });
  }

  try {
    const group = await prisma.contactGroup.findFirst({
      where: req.user.role === 'admin' ? { id } : { id, userId: req.user.id },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    if (contactIds.length > 0) {
      const owned = await prisma.contact.findMany({
        where: req.user.role === 'admin' ? { id: { in: contactIds } } : { id: { in: contactIds }, userId: req.user.id },
        select: { id: true },
      });
      if (owned.length !== contactIds.length) {
        return res.status(400).json({ error: 'One or more contacts were not found or do not belong to you' });
      }
    }

    await prisma.$transaction([
      prisma.contactGroupMember.deleteMany({ where: { groupId: id } }),
      prisma.contactGroupMember.createMany({
        data: contactIds.map((contactId) => ({ groupId: id, contactId })),
      }),
    ]);

    return res.json({ message: 'Group members updated' });
  } catch (err) {
    console.error('Set group members error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
