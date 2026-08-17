import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { generateSecret, generateURI, verifySync } from 'otplib';
import * as QRCode from 'qrcode';
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

    // Check if user has 2FA enabled
    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const mfaToken = jwt.sign(
        { id: user.id, email: user.email, type: '2fa_pending' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({
        require2FA: true,
        mfaToken,
        email: user.email,
      });
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
        twoFactorEnabled: false,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const verify2FALogin = async (req: AuthenticatedRequest, res: Response) => {
  const { mfaToken, code } = req.body;

  if (!mfaToken || !code) {
    return res.status(400).json({ error: 'Token MFA dan Kode OTP 2FA wajib diisi' });
  }

  try {
    const decoded = jwt.verify(mfaToken, JWT_SECRET) as { id: string; email: string; type: string };
    if (decoded.type !== '2fa_pending') {
      return res.status(401).json({ error: 'Token verifikasi 2FA tidak valid' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user || !user.isActive || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(401).json({ error: 'Pengguna tidak ditemukan atau 2FA tidak aktif' });
    }

    const { valid } = verifySync({ token: code.trim(), secret: user.twoFactorSecret });
    if (!valid) {
      return res.status(401).json({ error: 'Kode OTP Google 2FA salah / tidak valid' });
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
        twoFactorEnabled: user.twoFactorEnabled,
      },
    });
  } catch (err) {
    console.error('2FA Verify Login error:', err);
    return res.status(401).json({ error: 'Sesi verifikasi 2FA telah kadaluarsa. Silakan login kembali.' });
  }
};

export const setup2FA = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(404).json({ error: 'User tidak ditemukan' });
    }

    const secret = generateSecret();
    const serviceName = 'SendaGo WA';
    const otpauthUrl = generateURI({ secret, label: user.email, issuer: serviceName });
    const qrCode = await QRCode.toDataURL(otpauthUrl);

    const setupToken = jwt.sign(
      { id: user.id, secret, type: '2fa_setup' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    return res.json({
      secret,
      qrCode,
      setupToken,
    });
  } catch (err) {
    console.error('2FA Setup error:', err);
    return res.status(500).json({ error: 'Gagal membuat QR code 2FA' });
  }
};

export const enable2FA = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { setupToken, code } = req.body;
  if (!setupToken || !code) {
    return res.status(400).json({ error: 'Setup token dan Kode OTP 2FA wajib diisi' });
  }

  try {
    const decoded = jwt.verify(setupToken, JWT_SECRET) as { id: string; secret: string; type: string };
    if (decoded.type !== '2fa_setup' || decoded.id !== req.user.id) {
      return res.status(400).json({ error: 'Sesi pembuatan 2FA tidak valid' });
    }

    const { valid } = verifySync({ token: code.trim(), secret: decoded.secret });
    if (!valid) {
      return res.status(400).json({ error: 'Kode OTP Google 2FA salah. Periksa kembali aplikasi Google Authenticator Anda.' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: decoded.secret,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: '2FA_ENABLED',
        detail: 'Google 2FA Authenticator berhasil diaktifkan',
      },
    });

    return res.json({ success: true, message: 'Google 2FA berhasil diaktifkan' });
  } catch (err) {
    console.error('Enable 2FA error:', err);
    return res.status(400).json({ error: 'Verifikasi 2FA gagal atau token kadaluarsa' });
  }
};

export const disable2FA = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { code, password } = req.body;
  if (!code && !password) {
    return res.status(400).json({ error: 'Masukkan kode OTP 2FA atau Password untuk menonaktifkan 2FA' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(400).json({ error: 'Google 2FA belum diaktifkan pada akun ini' });
    }

    let isValid = false;
    if (code) {
      const { valid } = verifySync({ token: code.trim(), secret: user.twoFactorSecret });
      isValid = valid;
    } else if (password) {
      isValid = await bcrypt.compare(password, user.passwordHash);
    }

    if (!isValid) {
      return res.status(400).json({ error: 'Kode OTP 2FA atau Password tidak cocok' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: '2FA_DISABLED',
        detail: 'Google 2FA Authenticator dinonaktifkan',
      },
    });

    return res.json({ success: true, message: 'Google 2FA berhasil dinonaktifkan' });
  } catch (err) {
    console.error('Disable 2FA error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Public self-service signup - used by the landing page so a brand-new
// visitor can register and immediately proceed to a bundle checkout without
// waiting for an admin to create their account manually.
export const register = async (req: AuthenticatedRequest, res: Response) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nama, email, dan password wajib diisi' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password minimal 8 karakter' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email sudah terdaftar, silakan login' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, passwordHash, role: 'operator', isActive: true },
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, twoFactorEnabled: false },
    });
  } catch (err) {
    console.error('Register error:', err);
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
        twoFactorEnabled: true,
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

