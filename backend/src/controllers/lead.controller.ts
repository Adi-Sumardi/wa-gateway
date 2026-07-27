import { Request, Response } from 'express';
import { LeadStatus, PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

const VALID_STATUSES: LeadStatus[] = ['new', 'contacted', 'converted', 'closed'];

// Public - hit from the landing page's "Hubungi Kami" form, no auth.
export const createLead = async (req: Request, res: Response) => {
  const { name, phone, email, packageInterest, message } = req.body;

  if (!name || !phone || !packageInterest) {
    return res.status(400).json({ error: 'Parameters "name", "phone" and "packageInterest" are required' });
  }

  try {
    const lead = await prisma.lead.create({
      data: { name, phone, email: email || null, packageInterest, message: message || null },
    });
    return res.status(201).json({ message: 'Terima kasih, tim kami akan segera menghubungi Anda.', id: lead.id });
  } catch (err) {
    console.error('Create lead error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const listLeads = async (req: AuthenticatedRequest, res: Response) => {
  const { status } = req.query;
  try {
    const where = status && VALID_STATUSES.includes(status as LeadStatus) ? { status: status as LeadStatus } : {};
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ]);

    return res.json({ leads, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error('List leads error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateLeadStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        status: status !== undefined ? status : undefined,
        notes: notes !== undefined ? notes : undefined,
      },
    });
    return res.json(updated);
  } catch (err) {
    console.error('Update lead error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
