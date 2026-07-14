import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'sendago-super-secret-jwt-key';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

// Middleware to verify JWT for dashboard sessions
export const authenticateJWT = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; role: string };
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Middleware to check user roles
export const requireRole = (roles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
};

// Middleware to verify REST API Key for integrations
export const authenticateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({ error: 'API Key required (use X-API-KEY header or api_key query param)' });
  }

  // Hash the incoming key to compare with DB
  const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');

  try {
    const keyRecord = await prisma.apiKey.findUnique({
      where: { keyHash: hashedKey },
      include: { user: true },
    });

    if (!keyRecord || !keyRecord.isActive || !keyRecord.user.isActive) {
      return res.status(401).json({ error: 'Invalid or inactive API Key' });
    }

    // Update last used timestamp asynchronously
    prisma.apiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    }).catch(err => console.error('Error updating api key lastUsedAt:', err));

    // Attach user to request
    (req as AuthenticatedRequest).user = {
      id: keyRecord.user.id,
      email: keyRecord.user.email,
      role: keyRecord.user.role,
    };

    next();
  } catch (err) {
    console.error('API Key auth error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication' });
  }
};
