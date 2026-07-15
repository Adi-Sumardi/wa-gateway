import * as dotenv from 'dotenv';
dotenv.config();
import * as fs from 'fs';
import * as path from 'path';

import { io, Socket } from 'socket.io-client';
import { Client, LocalAuth, MessageAck, MessageMedia } from 'whatsapp-web.js';

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
const deviceQueues = new Map<string, { messageId: string; to: string; body: string; mediaUrl?: string; attempts?: number }[]>();

const MAX_SEND_ATTEMPTS = 3;

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

    // 1. SMART SLEEP period check: pause queue processing during specified hours (anti-banned)
    const currentHour = new Date().getHours();
    const sleepEnabled = process.env.SLEEP_ENABLED !== 'false'; // Default enabled
    const sleepStart = parseInt(process.env.SLEEP_START || '22', 10); // 10 PM
    const sleepEnd = parseInt(process.env.SLEEP_END || '7', 10);     // 7 AM

    let isSleepTime = false;
    if (sleepEnabled) {
      if (sleepStart > sleepEnd) {
        isSleepTime = currentHour >= sleepStart || currentHour < sleepEnd;
      } else {
        isSleepTime = currentHour >= sleepStart && currentHour < sleepEnd;
      }
    }

    if (isSleepTime) {
      console.log(`[Gateway] [Sleep] Current hour ${currentHour} is within sleep window (${sleepStart}-${sleepEnd}). Pausing queue for device ${deviceId}...`);
      setTimeout(processQueue, 30000); // Check again in 30 seconds
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
        
        let sentMsg;
        if (nextMsg.mediaUrl) {
          try {
            console.log(`[Gateway] [Media] Downloading and sending attachment: ${nextMsg.mediaUrl}`);
            const media = await MessageMedia.fromUrl(nextMsg.mediaUrl, { unsafeMime: true });
            sentMsg = await client.sendMessage(nextMsg.to, media, { caption: nextMsg.body });
          } catch (mediaErr: any) {
            console.error(`[Gateway] [Media] Download failed. Falling back to plain text. Error:`, mediaErr.message);
            // Graceful fallback to text message
            sentMsg = await client.sendMessage(nextMsg.to, `[Attachment Error: ${mediaErr.message}]\n\n${nextMsg.body}`);
          }
        } else {
          sentMsg = await client.sendMessage(nextMsg.to, nextMsg.body);
        }

        if (!sentMsg || !sentMsg.id) {
          throw new Error('sendMessage returned no message (client not fully synced yet)');
        }

        messageMap.set(sentMsg.id.id, nextMsg.messageId);

        socket.emit('message-status', {
          messageId: nextMsg.messageId,
          status: 'sent',
        });
      } catch (err: any) {
        const attempts = (nextMsg.attempts || 0) + 1;
        if (attempts < MAX_SEND_ATTEMPTS) {
          console.warn(`[Gateway] [Queue] Send attempt ${attempts} failed on device ${deviceId}, retrying:`, err.message);
          nextMsg.attempts = attempts;
          queue.unshift(nextMsg);
        } else {
          console.error(`[Gateway] [Queue] Error sending message on device ${deviceId} after ${attempts} attempts:`, err);
          socket.emit('message-status', {
            messageId: nextMsg.messageId,
            status: 'failed',
            failedReason: err.message || 'Unknown puppeteer/whatsapp error',
          });
        }
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

    // Clean up stale Chromium lock files in the persistent docker volume.
    // SingletonLock is a symlink pointing at "hostname-pid"; since that target
    // never resolves on a fresh host, fs.existsSync() (which follows symlinks)
    // wrongly reports it as absent. Use lstatSync/unlinkSync instead, which
    // operate on the symlink itself.
    const lockPath1 = path.join(process.cwd(), '.wwebjs_auth', `session-${deviceId}`, 'SingletonLock');
    const lockPath2 = path.join(process.cwd(), '.wwebjs_auth', `session-${deviceId}`, 'Default', 'SingletonLock');
    for (const lockPath of [lockPath1, lockPath2]) {
      try {
        fs.lstatSync(lockPath);
        fs.unlinkSync(lockPath);
        console.log(`[Gateway] Cleaned up stale Chromium SingletonLock: ${lockPath}`);
      } catch (lockErr: any) {
        if (lockErr.code !== 'ENOENT') {
          console.warn('[Gateway] Stale lock cleanup warning:', lockErr.message);
        }
      }
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: deviceId,
        dataPath: './.wwebjs_auth',
      }),
      // The whatsapp-web.js dependency ships a bundled WhatsApp Web version
      // that goes stale as WhatsApp updates their site, breaking the
      // library's internal Store injection (sendMessage silently returns
      // undefined). Pull a current version from the community-maintained
      // cache instead of relying on the bundled one.
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1043179329-alpha.html',
      },
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

socket.on('send-message', async (data: { messageId: string; deviceId: string; to: string; body: string; mediaUrl?: string }) => {
  const { messageId, deviceId, to, body, mediaUrl } = data;
  console.log(`[Gateway] Directive: Queue message on device ${deviceId} to ${to} (has media: ${!!mediaUrl})`);

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
  queue.push({ messageId, to, body, mediaUrl });

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
