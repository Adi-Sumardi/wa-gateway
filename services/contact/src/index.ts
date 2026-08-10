import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';
import { logAudit } from './audit';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6006;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'contact' }));

// ---- Contacts ----

app.get('/contacts', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const where: any = req.user!.role === 'admin' ? {} : { userId: req.user!.id };
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { phoneNumber: { contains: search } }];

    if (req.query.all === 'true') {
      const contacts = await prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' } });
      return res.json({ contacts, total: contacts.length, page: 1, limit: contacts.length, totalPages: 1 });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.contact.count({ where }),
    ]);
    return res.json({ contacts, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error('List contacts error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/contacts', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { name, phoneNumber, tags, notes } = req.body;
  if (!name || !phoneNumber) return res.status(400).json({ error: 'Parameters "name" and "phoneNumber" are required' });
  try {
    const contact = await prisma.contact.create({ data: { userId: req.user!.id, name, phoneNumber, tags: Array.isArray(tags) ? tags : undefined, notes: notes || undefined } });
    return res.status(201).json(contact);
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'A contact with this phone number already exists' });
    console.error('Create contact error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/contacts/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const { name, tags, notes, optedOut } = req.body;
  const contact = await prisma.contact.findFirst({ where: req.user!.role === 'admin' ? { id } : { id, userId: req.user!.id } });
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const updated = await prisma.contact.update({ where: { id }, data: { name, tags, notes, optedOut } });
  return res.json(updated);
});

app.delete('/contacts/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const contact = await prisma.contact.findFirst({ where: req.user!.role === 'admin' ? { id } : { id, userId: req.user!.id } });
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  await prisma.contact.delete({ where: { id } });
  logAudit(req.user!.id, 'contact.delete', `Deleted contact "${contact.name}" (${contact.phoneNumber})`);
  return res.json({ message: 'Contact deleted successfully' });
});

// ---- Contact groups ----

app.get('/contact-groups', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const groups = await prisma.contactGroup.findMany({
    where: req.user!.role === 'admin' ? {} : { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    include: { members: { select: { contactId: true } } },
  });
  return res.json(groups.map((g) => ({ ...g, memberContactIds: g.members.map((m) => m.contactId), members: undefined })));
});

app.post('/contact-groups', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Parameter "name" is required' });
  const group = await prisma.contactGroup.create({ data: { userId: req.user!.id, name, description: description || undefined } });
  return res.status(201).json(group);
});

app.delete('/contact-groups/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const group = await prisma.contactGroup.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!group) return res.status(404).json({ error: 'Group not found' });
  await prisma.contactGroup.delete({ where: { id: group.id } });
  return res.json({ message: 'Group deleted successfully' });
});

app.put('/contact-groups/:id/members', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const { contactIds } = req.body as { contactIds: string[] };
  if (!Array.isArray(contactIds)) return res.status(400).json({ error: '"contactIds" array is required' });

  const group = await prisma.contactGroup.findFirst({ where: req.user!.role === 'admin' ? { id } : { id, userId: req.user!.id } });
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (contactIds.length > 0) {
    const owned = await prisma.contact.findMany({ where: req.user!.role === 'admin' ? { id: { in: contactIds } } : { id: { in: contactIds }, userId: req.user!.id }, select: { id: true } });
    if (owned.length !== contactIds.length) return res.status(400).json({ error: 'One or more contacts were not found or do not belong to you' });
  }

  await prisma.$transaction([
    prisma.contactGroupMember.deleteMany({ where: { groupId: id } }),
    prisma.contactGroupMember.createMany({ data: contactIds.map((contactId) => ({ groupId: id, contactId })) }),
  ]);
  return res.json({ message: 'Group members updated' });
});

// ---- Internal ----

// Used by device-gateway-service when an inbound WhatsApp message arrives -
// mirrors the monolith's inline find-or-create in socket.ts.
app.post('/internal/contacts/find-or-create', async (req, res) => {
  const { userId, phoneNumber } = req.body;
  if (!userId || !phoneNumber) return res.status(400).json({ error: 'userId and phoneNumber are required' });
  let contact = await prisma.contact.findFirst({ where: { userId, phoneNumber } });
  if (!contact) {
    contact = await prisma.contact.create({ data: { userId, name: phoneNumber, phoneNumber } });
  }
  return res.json(contact);
});

// Batch lookup - used by messaging-service to enrich a page of messages
// with contact name/phone without an HTTP round-trip per row.
app.get('/internal/contacts', async (req, res) => {
  const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').filter(Boolean) : [];
  const contacts = await prisma.contact.findMany({ where: { id: { in: ids } } });
  return res.json(contacts);
});

app.get('/internal/contacts/:id', async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  return res.json(contact);
});

app.listen(PORT, () => console.log(`[contact] listening on ${PORT}`));
