import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as jwt from 'jsonwebtoken';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = process.env.PORT || 6000;
const JWT_SECRET = process.env.JWT_SECRET || 'sendago-super-secret-jwt-key';

const SERVICES = {
  identity: process.env.IDENTITY_SERVICE_URL || 'http://identity:6001',
  deviceGateway: process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002',
  messaging: process.env.MESSAGING_SERVICE_URL || 'http://messaging:6003',
  conversationAi: process.env.CONVERSATION_AI_SERVICE_URL || 'http://conversation-ai:6004',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://notification:6005',
  contact: process.env.CONTACT_SERVICE_URL || 'http://contact:6006',
  template: process.env.TEMPLATE_SERVICE_URL || 'http://template:6007',
  campaign: process.env.CAMPAIGN_SERVICE_URL || 'http://campaign:6008',
  billing: process.env.BILLING_SERVICE_URL || 'http://billing:6009',
  warmer: process.env.WARMER_SERVICE_URL || 'http://warmer:6010',
  audit: process.env.AUDIT_SERVICE_URL || 'http://audit:6011',
};

app.use(cors());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

// Public API integrations authenticate with X-API-KEY instead of a JWT.
// Resolve it once here (against identity-service) and mint the same-shaped
// JWT every downstream service already knows how to verify, so
// authenticateJWT stays the single auth check everywhere else.
app.use(async (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey || typeof apiKey !== 'string' || req.headers.authorization) return next();
  try {
    const resp = await fetch(`${SERVICES.identity}/internal/apikeys/validate?key=${encodeURIComponent(apiKey)}`);
    if (!resp.ok) return res.status(401).json({ error: 'Invalid or inactive API Key' });
    const user = (await resp.json()) as { id: string; email: string; role: string };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '5m' });
    req.headers.authorization = `Bearer ${token}`;
    next();
  } catch (err) {
    console.error('[api-gateway] API key resolution failed:', err);
    return res.status(503).json({ error: 'Identity service unavailable' });
  }
});

// Composed endpoint - identity owns core user fields, billing owns every
// quota/credit number; the dashboard wants both in one response like the
// old monolith's single `users` table used to give it for free.
app.get('/api/auth/me', express.json(), async (req: Request, res: Response) => {
  if (!req.headers.authorization) return res.status(401).json({ error: 'Authorization token required' });
  try {
    const meResp = await fetch(`${SERVICES.identity}/auth/me`, { headers: { authorization: req.headers.authorization as string } });
    if (!meResp.ok) return res.status(meResp.status).json(await meResp.json());
    const user = (await meResp.json()) as any;
    const quotaResp = await fetch(`${SERVICES.billing}/internal/quota/${user.id}`);
    const quota = quotaResp.ok ? await quotaResp.json() : {};
    return res.json({ ...user, ...quota });
  } catch (err) {
    console.error('[api-gateway] /api/auth/me composition failed:', err);
    return res.status(502).json({ error: 'Upstream service error' });
  }
});

// ---- Route table: public path prefix -> owning service ----
const routes: { path: string; target: string; stripApiPrefix?: boolean }[] = [
  { path: '/api/auth', target: SERVICES.identity },
  { path: '/api/permissions', target: SERVICES.identity },
  { path: '/api/users', target: SERVICES.identity },
  { path: '/api/apikeys', target: SERVICES.identity },

  { path: '/api/devices', target: SERVICES.deviceGateway },

  { path: '/api/messages', target: SERVICES.messaging },

  { path: '/api/ai-escalations', target: SERVICES.conversationAi },

  { path: '/api/webhooks', target: SERVICES.notification },

  { path: '/api/contacts', target: SERVICES.contact },
  { path: '/api/contact-groups', target: SERVICES.contact },

  { path: '/api/templates', target: SERVICES.template },

  { path: '/api/broadcasts', target: SERVICES.campaign },
  { path: '/api/leads', target: SERVICES.campaign },
  { path: '/api/links', target: SERVICES.campaign },
  { path: '/l', target: SERVICES.campaign },

  { path: '/api/credits', target: SERVICES.billing },
  { path: '/api/credit-packages', target: SERVICES.billing },
  { path: '/api/credit-orders', target: SERVICES.billing },
  { path: '/api/bundle-packages', target: SERVICES.billing },
  { path: '/api/bundle-orders', target: SERVICES.billing },
  { path: '/api/midtrans', target: SERVICES.billing },

  { path: '/api/warmers', target: SERVICES.warmer },

  { path: '/api/audit-logs', target: SERVICES.audit },
];

// Longest-prefix-first so e.g. /api/credit-packages doesn't get swallowed by
// a hypothetical shorter /api/credit prefix registered earlier.
// Every service's own routes are defined WITHOUT the "/api" prefix (e.g.
// device-gateway listens on "/devices", not "/api/devices") - strip it here
// so the gateway is the only place that prefix has to mean anything.
for (const route of routes.sort((a, b) => b.path.length - a.path.length)) {
  app.use(route.path, createProxyMiddleware({
    target: route.target,
    changeOrigin: true,
    pathRewrite: route.path.startsWith('/api') ? { '^/api': '' } : undefined,
  }));
}

app.listen(PORT, () => console.log(`[api-gateway] listening on ${PORT}`));
