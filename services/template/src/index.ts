import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, AuthenticatedRequest } from './_shared/auth-middleware';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 6007;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'template' }));

app.get('/templates', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const templates = await prisma.template.findMany({ where: req.user!.role === 'admin' ? {} : { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
  return res.json(templates);
});

app.post('/templates', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { name, content, mediaUrl, mediaType } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'Parameters "name" and "content" are required' });
  const template = await prisma.template.create({ data: { userId: req.user!.id, name, content, mediaUrl: mediaUrl || null, mediaType: mediaUrl ? (mediaType || 'document') : 'none' } });
  return res.status(201).json(template);
});

app.patch('/templates/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const { name, content, mediaUrl, mediaType } = req.body;
  const template = await prisma.template.findFirst({ where: req.user!.role === 'admin' ? { id } : { id, userId: req.user!.id } });
  if (!template) return res.status(404).json({ error: 'Template not found' });
  const updated = await prisma.template.update({ where: { id }, data: { name, content, mediaUrl: mediaUrl !== undefined ? mediaUrl || null : undefined, mediaType } });
  return res.json(updated);
});

app.delete('/templates/:id', authenticateJWT, async (req: AuthenticatedRequest, res) => {
  const template = await prisma.template.findFirst({ where: req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, userId: req.user!.id } });
  if (!template) return res.status(404).json({ error: 'Template not found' });
  await prisma.template.delete({ where: { id: template.id } });
  return res.json({ message: 'Template deleted successfully' });
});

// Used by campaign-service to hold a broadcast's freeform body/media when no
// existing saved template was picked.
app.post('/internal/templates', async (req, res) => {
  const { userId, name, content, mediaUrl, mediaType } = req.body;
  const template = await prisma.template.create({ data: { userId, name, content, mediaUrl: mediaUrl || null, mediaType: mediaType || 'none' } });
  return res.status(201).json(template);
});

app.get('/internal/templates/:id', async (req, res) => {
  const template = await prisma.template.findUnique({ where: { id: req.params.id } });
  if (!template) return res.status(404).json({ error: 'Not found' });
  return res.json(template);
});

app.listen(PORT, () => console.log(`[template] listening on ${PORT}`));
