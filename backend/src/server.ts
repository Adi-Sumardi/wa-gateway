import * as dotenv from 'dotenv';
// Load environment variables
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { initSocket } from './socket';
import { authenticateJWT, authenticateApiKey } from './middleware/auth.middleware';

// Controllers
import * as authController from './controllers/auth.controller';
import * as deviceController from './controllers/device.controller';
import * as messageController from './controllers/message.controller';
import * as webhookController from './controllers/webhook.controller';
import * as apikeyController from './controllers/apikey.controller';
import * as linkController from './controllers/link.controller';

const app = express();
const httpServer = createServer(app);

// Initialize Socket.io
initSocket(httpServer);

// Configure middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Diagnostic endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Authentication Routes
app.post('/api/auth/login', authController.login);
app.post('/api/auth/register', authController.register); // Allowed public for initial registration
app.get('/api/auth/me', authenticateJWT, authController.me);

// Device Management Routes
app.get('/api/devices', authenticateJWT, deviceController.listDevices);
app.post('/api/devices', authenticateJWT, deviceController.createDevice);
app.post('/api/devices/:id/reconnect', authenticateJWT, deviceController.reconnectDevice);
app.delete('/api/devices/:id', authenticateJWT, deviceController.deleteDevice);
app.patch('/api/devices/:id/ai', authenticateJWT, deviceController.updateDeviceAi);

// Message Routes
// Outbound send supports BOTH API Key auth (for CRM integration) and JWT auth (from Dashboard)
app.post('/api/messages', (req, res, next) => {
  // If X-API-KEY header is present or api_key query param exists, use API key auth
  if (req.headers['x-api-key'] || req.query.api_key) {
    return authenticateApiKey(req, res, next);
  }
  // Otherwise default to Dashboard JWT session authentication
  return authenticateJWT(req, res, next);
}, messageController.sendMessage);

app.get('/api/messages', authenticateJWT, messageController.getMessages);

// Webhook Routes
app.get('/api/webhooks', authenticateJWT, webhookController.listWebhooks);
app.post('/api/webhooks', authenticateJWT, webhookController.createWebhook);
app.delete('/api/webhooks/:id', authenticateJWT, webhookController.deleteWebhook);
app.get('/api/webhooks/logs', authenticateJWT, webhookController.getWebhookLogs);

// API Key Routes
app.get('/api/apikeys', authenticateJWT, apikeyController.listKeys);
app.post('/api/apikeys', authenticateJWT, apikeyController.createKey);
app.delete('/api/apikeys/:id', authenticateJWT, apikeyController.deleteKey);

// Link Shortener & Tracker Routes
app.post('/api/links/shorten', authenticateJWT, linkController.shortenUrl);
app.get('/api/links', authenticateJWT, linkController.listLinks);
app.get('/l/:code', linkController.redirectUrl);

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`[Server] SendaGo API Backend listening on port ${PORT}`);
});
