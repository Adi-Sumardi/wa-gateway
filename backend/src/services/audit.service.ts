import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Fire-and-forget: never awaited by callers, never throws, so a logging
// failure can't break the request that triggered it.
export const logAudit = (userId: string, action: string, detail: string) => {
  prisma.auditLog.create({ data: { userId, action, detail } }).catch((err) => {
    console.error('[Audit] Failed to log:', err);
  });
};
