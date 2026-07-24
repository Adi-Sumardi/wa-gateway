import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'sendago-super-secret-jwt-key';

export const login = async (req: AuthenticatedRequest, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Email tidak terdaftar' });
    }
    if (!user.isActive) {
      return res.status(401).json({ error: 'Akun ini telah dinonaktifkan. Hubungi admin Anda.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Password yang Anda masukkan salah' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const me = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, name: true, email: true, role: true, isActive: true,
        aiCreditBalance: true, maxDevices: true,
        broadcastQuotaMonthly: true, broadcastSentThisMonth: true, maxWarmerSessions: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json(user);
  } catch (err) {
    console.error('Me query error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
