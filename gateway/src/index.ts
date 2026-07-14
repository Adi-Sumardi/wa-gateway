import * as dotenv from 'dotenv';
dotenv.config();

import { io, Socket } from 'socket.io-client';
import { Client, LocalAuth, MessageAck } from 'whatsapp-web.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'sendago-gateway-secret-token';

console.log(`[Gateway] Starting... Connecting to Backend at ${BACKEND_URL}`);

const socket: Socket = io(BACKEND_URL, {
  auth: {
    type: 'gateway',
    token: GATEWAY_TOKEN,
  },
  reconnection: true,
});

// Map of active WhatsApp Client instances, keyed by device ID
const clients = new Map<string, Client>();

// Map of WA Message ID -> DB Message ID to track ACKs
const messageMap = new Map<string, string>();

// Map to hold outbound message queues per device ID
const deviceQueues = new Map<string, { messageId: string; to: string; body: string }[]>();

// Set to track which devices have an active queue worker loop
const activeWorkers = new Set<string>();

const startQueueWorker = (deviceId: string) => {
  if (activeWorkers.has(deviceId)) return;
  activeWorkers.add(deviceId);

  const processQueue = async () => {
    if (!clients.has(deviceId)) {
      activeWorkers.delete(deviceId);
      deviceQueues.delete(deviceId);
      return;
    }

    const queue = deviceQueues.get(deviceId) || [];
    const client = clients.get(deviceId);

    if (queue.length === 0 || !client || !client.info) {
      setTimeout(processQueue, 1000);
      return;
    }

    const nextMsg = queue.shift();
    if (nextMsg) {
      try {
        console.log(`[Gateway] [Queue] Sending message to ${nextMsg.to} on device ${deviceId}. Queue size: ${queue.length}`);
        const sentMsg = await client.sendMessage(nextMsg.to, nextMsg.body);
        messageMap.set(sentMsg.id.id, nextMsg.messageId);

        socket.emit('message-status', {
          messageId: nextMsg.messageId,
          status: 'sent',
        });
      } catch (err: any) {
        console.error(`[Gateway] [Queue] Error sending message on device ${deviceId}:`, err);
        socket.emit('message-status', {
          messageId: nextMsg.messageId,
          status: 'failed',
          failedReason: err.message || 'Unknown puppeteer/whatsapp error',
        });
      }
    }

    const minDelay = parseInt(process.env.MIN_SEND_DELAY || '3000', 10);
    const maxDelay = parseInt(process.env.MAX_SEND_DELAY || '7000', 10);
    const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    setTimeout(processQueue, randomDelay);
  };

  setTimeout(processQueue, 1000);
};

socket.on('connect', () => {
  console.log('[Gateway] Connected to backend Socket.io server.');
});

socket.on('disconnect', () => {
  console.log('[Gateway] Disconnected from backend Socket.io server.');
});

// Directives from Backend API
socket.on('init-device', async (data: { deviceId: string }) => {
  const { deviceId } = data;
  console.log(`[Gateway] Directive: Initialize device ${deviceId}`);

  if (clients.has(deviceId)) {
    console.log(`[Gateway] Device ${deviceId} already has an active client. Restarting it.`);
    await destroyDevice(deviceId);
  }

  try {
    socket.emit('device-status', { deviceId, status: 'connecting' });

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: deviceId,
        dataPath: './.wwebjs_auth',
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      },
    });

    clients.set(deviceId, client);

    client.on('qr', (qr) => {
      console.log(`[Gateway] Device ${deviceId} generated QR code.`);
      // Send QR string to backend
      socket.emit('device-qr', { deviceId, qr });
    });

    client.on('ready', () => {
      const phoneNumber = client.info.wid.user;
      console.log(`[Gateway] Device ${deviceId} is READY. Phone: ${phoneNumber}`);
      socket.emit('device-status', { deviceId, status: 'connected', phoneNumber });
      startQueueWorker(deviceId);
    });

    client.on('authenticated', () => {
      console.log(`[Gateway] Device ${deviceId} authenticated successfully.`);
    });

    client.on('auth_failure', (msg) => {
      console.error(`[Gateway] Device ${deviceId} authentication failure:`, msg);
      socket.emit('device-status', { deviceId, status: 'banned' });
    });

    client.on('disconnected', (reason) => {
      console.warn(`[Gateway] Device ${deviceId} disconnected. Reason: ${reason}`);
      socket.emit('device-status', { deviceId, status: 'disconnected' });
      destroyDevice(deviceId);
    });

    // Inbound messages
    client.on('message', async (msg) => {
      if (msg.fromMe) return; // ignore outbound messages triggered on phone
      
      console.log(`[Gateway] Device ${deviceId} received message from ${msg.from}`);
      socket.emit('incoming-message', {
        deviceId,
        from: msg.from.replace('@c.us', ''),
        body: msg.body,
      });
    });

    // Track status delivery of sent messages (ACKs)
    client.on('message_ack', (msg, ack) => {
      const dbMsgId = messageMap.get(msg.id.id);
      if (dbMsgId) {
        let status = 'sent';
        if (ack === MessageAck.ACK_SERVER) {
          status = 'sent';
        } else if (ack === MessageAck.ACK_DEVICE) {
          status = 'delivered';
        } else if (ack === MessageAck.ACK_READ) {
          status = 'read';
        } else if (ack === MessageAck.ACK_ERROR) {
          status = 'failed';
        }

        console.log(`[Gateway] Message ACK: ${msg.id.id} -> ${status} (${ack})`);
        socket.emit('message-status', {
          messageId: dbMsgId,
          status,
        });

        if (status === 'read' || status === 'failed') {
          messageMap.delete(msg.id.id); // clear memory
        }
      }
    });

    client.initialize().catch((err) => {
      console.error(`[Gateway] Failed to initialize client for device ${deviceId}:`, err);
      socket.emit('device-status', { deviceId, status: 'disconnected' });
      clients.delete(deviceId);
    });

  } catch (err) {
    console.error(`[Gateway] Error setting up device ${deviceId}:`, err);
    socket.emit('device-status', { deviceId, status: 'disconnected' });
  }
});

socket.on('logout-device', async (data: { deviceId: string }) => {
  console.log(`[Gateway] Directive: Logout device ${data.deviceId}`);
  await destroyDevice(data.deviceId);
});

socket.on('send-message', async (data: { messageId: string; deviceId: string; to: string; body: string }) => {
  const { messageId, deviceId, to, body } = data;
  console.log(`[Gateway] Directive: Queue message on device ${deviceId} to ${to}`);

  const client = clients.get(deviceId);
  if (!client) {
    console.error(`[Gateway] Device ${deviceId} client not found in memory`);
    socket.emit('message-status', {
      messageId,
      status: 'failed',
      failedReason: 'Device client process not initialized',
    });
    return;
  }

  // Push to FIFO Queue
  let queue = deviceQueues.get(deviceId);
  if (!queue) {
    queue = [];
    deviceQueues.set(deviceId, queue);
  }
  queue.push({ messageId, to, body });

  // Ensure worker is running
  startQueueWorker(deviceId);
});

// Helper to destroy client instance
async function destroyDevice(deviceId: string) {
  deviceQueues.delete(deviceId);
  activeWorkers.delete(deviceId);

  const client = clients.get(deviceId);
  if (client) {
    try {
      await client.destroy();
      console.log(`[Gateway] Client destroyed for device ${deviceId}`);
    } catch (err) {
      console.error(`[Gateway] Error destroying client for device ${deviceId}:`, err);
    } finally {
      clients.delete(deviceId);
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[Gateway] SIGINT received. Cleaning up all clients...');
  for (const [deviceId, client] of clients.entries()) {
    try {
      await client.destroy();
    } catch (e) {}
  }
  process.exit(0);
});
