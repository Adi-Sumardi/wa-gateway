import { publish } from './_shared/events';

export const logAudit = (userId: string, action: string, detail: string) => {
  publish('audit.logged', { userId, action, detail, at: new Date().toISOString() }).catch((err) => {
    console.error('[Audit] Failed to publish audit event:', err);
  });
};
