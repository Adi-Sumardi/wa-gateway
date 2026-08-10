// Duplicated into every service (no private npm registry to publish a shared
// package to) - authentication is local/stateless (JWT), but permission
// checks defer to identity-service, the single source of truth for
// role_permissions. See SendaGo_WA_Architecture.md for the rationale.
import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'sendago-super-secret-jwt-key';
const IDENTITY_URL = process.env.IDENTITY_SERVICE_URL || 'http://identity:6001';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

export const authenticateJWT = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as { id: string; email: string; role: string };
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Admins always pass (mirrors the monolith's rule); everyone else is checked
// against identity-service's role_permissions table over HTTP, with a short
// timeout so a slow/degraded Identity service fails closed, not hung.
export const requirePermission = (key: string) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.role === 'admin') return next();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${IDENTITY_URL}/internal/permissions/check?role=${req.user.role}&key=${key}`, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await resp.json() as { granted: boolean };
      if (!data.granted) return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      next();
    } catch (err) {
      console.error('[auth] permission check failed:', err);
      return res.status(503).json({ error: 'Permission service unavailable' });
    }
  };
};
