import * as dotenv from 'dotenv';
// Load environment variables
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { initSocket } from './socket';
import { authenticateJWT, authenticateApiKey, requirePermission } from './middleware/auth.middleware';
import { initScheduler } from './services/scheduler';
import { backfillLegacyOwnership } from './services/ownership.service';

// Controllers
import * as authController from './controllers/auth.controller';
import * as deviceController from './controllers/device.controller';
import * as messageController from './controllers/message.controller';
import * as webhookController from './controllers/webhook.controller';
import * as apikeyController from './controllers/apikey.controller';
import * as linkController from './controllers/link.controller';
import * as broadcastController from './controllers/broadcast.controller';
import * as warmerController from './controllers/warmer.controller';
import * as userController from './controllers/user.controller';
import * as contactController from './controllers/contact.controller';
import * as contactGroupController from './controllers/contact-group.controller';
import * as templateController from './controllers/template.controller';
import * as creditController from './controllers/credit.controller';
import * as creditPackageController from './controllers/credit-package.controller';
import * as creditOrderController from './controllers/credit-order.controller';
import * as bundlePackageController from './controllers/bundle-package.controller';
import * as bundleOrderController from './controllers/bundle-order.controller';
import * as leadController from './controllers/lead.controller';

const app = express();
const httpServer = createServer(app);

// Initialize Socket.io
initSocket(httpServer);

// Configure middleware
// Auth uses a Bearer token in the Authorization header, not cookies, so
// credentials:true is unnecessary here - and actively breaks CORS when
// CORS_ORIGIN is "*", since browsers reject a wildcard origin combined
// with Access-Control-Allow-Credentials on the same response.
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
}));
app.use(express.json());

// Diagnostic endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Authentication Routes
app.post('/api/auth/login', authController.login);
app.post('/api/auth/register', authController.register);
app.get('/api/auth/me', authenticateJWT, authController.me);
app.get('/api/permissions/me', authenticateJWT, userController.getMyPermissions);

// User, Role & Permission Management Routes (admin only)
app.get('/api/users', authenticateJWT, requirePermission('users.manage'), userController.listUsers);
app.post('/api/users', authenticateJWT, requirePermission('users.manage'), userController.createUser);
app.patch('/api/users/:id', authenticateJWT, requirePermission('users.manage'), userController.updateUser);
app.get('/api/permissions', authenticateJWT, requirePermission('users.manage'), userController.getPermissionMatrix);
app.put('/api/permissions', authenticateJWT, requirePermission('users.manage'), userController.updatePermissionMatrix);
app.get('/api/audit-logs', authenticateJWT, requirePermission('audit.view'), userController.getAuditLogs);

// AI Credit (Coin) Routes - topUpCredit hard-checks admin internally, same
// pattern as device transfer; getTransactions allows admin or self.
app.post('/api/credits/:userId/topup', authenticateJWT, requirePermission('credits.manage'), creditController.topUpCredit);
app.get('/api/credits/:userId/transactions', authenticateJWT, creditController.getTransactions);

// AI Credit Packages & Midtrans self-service top-up
app.get('/api/credit-packages', authenticateJWT, creditPackageController.listPackages);
app.post('/api/credit-packages', authenticateJWT, requirePermission('credits.manage'), creditPackageController.createPackage);
app.patch('/api/credit-packages/:id', authenticateJWT, requirePermission('credits.manage'), creditPackageController.updatePackage);
app.delete('/api/credit-packages/:id', authenticateJWT, requirePermission('credits.manage'), creditPackageController.deletePackage);

app.post('/api/credit-orders', authenticateJWT, creditOrderController.createOrder);
app.get('/api/credit-orders/me', authenticateJWT, creditOrderController.getMyOrders);
app.post('/api/credit-orders/:id/cancel', authenticateJWT, creditOrderController.cancelOrder);
// Public: called server-to-server by Midtrans, authenticated via signature
// verification inside the handler, not a JWT.
app.post('/api/midtrans/webhook', creditOrderController.handleWebhook);

// Bundle Packages ("Paket Coba" etc.) - grant multiple product types from a
// single purchase. Public listing feeds the /promo landing page.
app.get('/api/bundle-packages', bundlePackageController.listPublicBundles);
app.get('/api/bundle-packages/admin', authenticateJWT, requirePermission('credits.manage'), bundlePackageController.listAdminBundles);
app.post('/api/bundle-packages', authenticateJWT, requirePermission('credits.manage'), bundlePackageController.createBundle);
app.patch('/api/bundle-packages/:id', authenticateJWT, requirePermission('credits.manage'), bundlePackageController.updateBundle);
app.delete('/api/bundle-packages/:id', authenticateJWT, requirePermission('credits.manage'), bundlePackageController.deleteBundle);

app.post('/api/bundle-orders', authenticateJWT, bundleOrderController.createOrder);
app.get('/api/bundle-orders/me', authenticateJWT, bundleOrderController.getMyOrders);
app.post('/api/bundle-orders/:id/cancel', authenticateJWT, bundleOrderController.cancelOrder);
app.post('/api/midtrans/bundle-webhook', bundleOrderController.handleWebhook);

// Leads - manual-fulfillment offers (e.g. "Paket Pasangin") captured from the
// public landing page, followed up by admin/sales.
app.post('/api/leads', leadController.createLead);
app.get('/api/leads', authenticateJWT, requirePermission('leads.view'), leadController.listLeads);
app.patch('/api/leads/:id', authenticateJWT, requirePermission('leads.view'), leadController.updateLeadStatus);

// Device Management Routes
app.get('/api/devices', authenticateJWT, requirePermission('devices.view'), deviceController.listDevices);
app.post('/api/devices', authenticateJWT, requirePermission('devices.manage'), deviceController.createDevice);
app.post('/api/devices/:id/reconnect', authenticateJWT, requirePermission('devices.manage'), deviceController.reconnectDevice);
app.delete('/api/devices/:id', authenticateJWT, requirePermission('devices.manage'), deviceController.deleteDevice);
app.patch('/api/devices/:id/ai', authenticateJWT, requirePermission('devices.manage'), deviceController.updateDeviceAi);
app.patch('/api/devices/:id/transfer', authenticateJWT, requirePermission('devices.manage'), deviceController.transferDevice);

// Message Routes
// Outbound send supports BOTH API Key auth (for CRM integration) and JWT auth (from Dashboard)
app.post('/api/messages', (req, res, next) => {
  // If X-API-KEY header is present or api_key query param exists, use API key auth
  if (req.headers['x-api-key'] || req.query.api_key) {
    return authenticateApiKey(req, res, next);
  }
  // Otherwise default to Dashboard JWT session authentication
  return authenticateJWT(req, res, next);
}, (req, res, next) => {
  // API-key integrations are a separate trusted surface; only gate the JWT (dashboard) path.
  if (req.headers['x-api-key'] || req.query.api_key) return next();
  return requirePermission('messages.send')(req, res, next);
}, messageController.sendMessage);

app.get('/api/messages', authenticateJWT, requirePermission('messages.view'), messageController.getMessages);

// Webhook Routes
app.get('/api/webhooks', authenticateJWT, requirePermission('webhooks.manage'), webhookController.listWebhooks);
app.post('/api/webhooks', authenticateJWT, requirePermission('webhooks.manage'), webhookController.createWebhook);
app.delete('/api/webhooks/:id', authenticateJWT, requirePermission('webhooks.manage'), webhookController.deleteWebhook);
app.get('/api/webhooks/logs', authenticateJWT, requirePermission('webhooks.manage'), webhookController.getWebhookLogs);

// API Key Routes
app.get('/api/apikeys', authenticateJWT, requirePermission('apikeys.manage'), apikeyController.listKeys);
app.post('/api/apikeys', authenticateJWT, requirePermission('apikeys.manage'), apikeyController.createKey);
app.delete('/api/apikeys/:id', authenticateJWT, requirePermission('apikeys.manage'), apikeyController.deleteKey);

// Link Shortener & Tracker Routes
app.post('/api/links/shorten', authenticateJWT, requirePermission('links.manage'), linkController.shortenUrl);
app.get('/api/links', authenticateJWT, requirePermission('links.manage'), linkController.listLinks);
app.get('/l/:code', linkController.redirectUrl);

// Broadcast Routes
app.post('/api/broadcasts', authenticateJWT, requirePermission('broadcast.manage'), broadcastController.createBroadcast);
app.get('/api/broadcasts', authenticateJWT, requirePermission('broadcast.view'), broadcastController.listBroadcasts);
app.get('/api/broadcasts/:id', authenticateJWT, requirePermission('broadcast.view'), broadcastController.getBroadcast);
app.post('/api/broadcasts/:id/start', authenticateJWT, requirePermission('broadcast.manage'), broadcastController.startBroadcast);
app.post('/api/broadcasts/:id/pause', authenticateJWT, requirePermission('broadcast.manage'), broadcastController.pauseBroadcast);
app.delete('/api/broadcasts/:id', authenticateJWT, requirePermission('broadcast.manage'), broadcastController.deleteBroadcast);

// Contact & Contact Group Routes
app.get('/api/contacts', authenticateJWT, requirePermission('contacts.view'), contactController.listContacts);
app.post('/api/contacts', authenticateJWT, requirePermission('contacts.manage'), contactController.createContact);
app.patch('/api/contacts/:id', authenticateJWT, requirePermission('contacts.manage'), contactController.updateContact);
app.delete('/api/contacts/:id', authenticateJWT, requirePermission('contacts.manage'), contactController.deleteContact);

app.get('/api/contact-groups', authenticateJWT, requirePermission('contacts.view'), contactGroupController.listGroups);
app.post('/api/contact-groups', authenticateJWT, requirePermission('contacts.manage'), contactGroupController.createGroup);
app.delete('/api/contact-groups/:id', authenticateJWT, requirePermission('contacts.manage'), contactGroupController.deleteGroup);
app.put('/api/contact-groups/:id/members', authenticateJWT, requirePermission('contacts.manage'), contactGroupController.setGroupMembers);

// Template Routes
app.get('/api/templates', authenticateJWT, requirePermission('templates.view'), templateController.listTemplates);
app.post('/api/templates', authenticateJWT, requirePermission('templates.manage'), templateController.createTemplate);
app.patch('/api/templates/:id', authenticateJWT, requirePermission('templates.manage'), templateController.updateTemplate);
app.delete('/api/templates/:id', authenticateJWT, requirePermission('templates.manage'), templateController.deleteTemplate);

// WA Warmer Routes
app.post('/api/warmers', authenticateJWT, requirePermission('warmer.manage'), warmerController.createWarmer);
app.get('/api/warmers', authenticateJWT, requirePermission('warmer.view'), warmerController.listWarmers);
app.get('/api/warmers/:id/logs', authenticateJWT, requirePermission('warmer.view'), warmerController.getWarmerLogs);
app.post('/api/warmers/:id/start', authenticateJWT, requirePermission('warmer.manage'), warmerController.startWarmer);
app.post('/api/warmers/:id/pause', authenticateJWT, requirePermission('warmer.manage'), warmerController.pauseWarmer);
app.delete('/api/warmers/:id', authenticateJWT, requirePermission('warmer.manage'), warmerController.deleteWarmer);

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`[Server] SendaGo API Backend listening on port ${PORT}`);
  backfillLegacyOwnership().catch((err) => console.error('[Ownership] Backfill failed:', err));
  initScheduler().catch((err) => console.error('[Scheduler] Failed to initialize:', err));
});
