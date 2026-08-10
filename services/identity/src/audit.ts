// Publishes to the bus instead of writing a row directly - audit-service owns
// the audit_logs table now, so every service (not just this one) logs the
// same way. Fire-and-forget: a logging failure must never break the request.
import { publish } from './_shared/events';

export const logAudit = (userId: string, action: string, detail: string) => {
  publish('audit.logged', { userId, action, detail, at: new Date().toISOString() }).catch((err) => {
    console.error('[Audit] Failed to publish audit event:', err);
  });
};
