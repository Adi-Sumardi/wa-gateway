// Hosts the Socket.io server the whatsapp-web.js worker process (gateway/)
// connects to - the "adapter" half of the old monolith's socket.ts. Raw WA
// events are turned into domain events on the bus instead of being handled
// inline, so other services never need to know the gateway protocol exists.
import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { PrismaClient, DeviceStatus, Device } from '@prisma/client';
import { publish } from './_shared/events';

const prisma = new PrismaClient();
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'sendago-gateway-secret-token';
const CONTACT_URL = process.env.CONTACT_SERVICE_URL || 'http://contact:6006';

let io: SocketServer | null = null;
let gatewaySocket: Socket | null = null;

export const initGatewaySocket = (server: HTTPServer) => {
  io = new SocketServer(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

  io.on('connection', (socket: Socket) => {
    const token = socket.handshake.auth?.token;
    if (token !== GATEWAY_TOKEN) {
      console.warn(`[device-gateway] Rejected connection with invalid token: ${token}`);
      socket.disconnect();
      return;
    }

    console.log(`[device-gateway] WA worker connected: ${socket.id}`);
    gatewaySocket = socket;

    (async () => {
      try {
        const allDevices = await prisma.device.findMany();
        console.log(`[device-gateway] Restoring ${allDevices.length} registered devices in worker memory...`);
        for (const dev of allDevices) socket.emit('init-device', { deviceId: dev.id });
      } catch (err) {
        console.error('[device-gateway] Failed to load devices for auto-restore:', err);
      }
    })();

    socket.on('disconnect', () => {
      console.log(`[device-gateway] WA worker disconnected: ${socket.id}`);
      if (gatewaySocket?.id === socket.id) gatewaySocket = null;
    });

    socket.on('device-status', async (data: { deviceId: string; status: DeviceStatus; phoneNumber?: string }) => {
      console.log(`[device-gateway] Device status update: ${data.deviceId} -> ${data.status}`);
      try {
        const device = await prisma.device.findUnique({ where: { id: data.deviceId } });
        if (!device) {
          console.warn(`[device-gateway] Ignored status update for unknown/deleted device ${data.deviceId}`);
          return;
        }
        await prisma.device.update({
          where: { id: data.deviceId },
          data: { status: data.status, phoneNumber: data.phoneNumber || undefined, lastConnectedAt: data.status === 'connected' ? new Date() : undefined },
        });
        publish('device.status.changed', { userId: device.userId, deviceId: data.deviceId, status: data.status, phoneNumber: data.phoneNumber || null }).catch((e) => console.error(e));
      } catch (err) {
        console.error(`[device-gateway] Error updating device ${data.deviceId} status:`, err);
      }
    });

    socket.on('device-qr', async (data: { deviceId: string; qr: string }) => {
      try {
        const device = await prisma.device.findUnique({ where: { id: data.deviceId } });
        if (!device) return;
        publish('device.qr.generated', { userId: device.userId, deviceId: data.deviceId, qr: data.qr }).catch((e) => console.error(e));
      } catch (err) {
        console.error(`[device-gateway] Error resolving owner for device-qr ${data.deviceId}:`, err);
      }
    });

    // ACKs for outbound messages - just forward, messaging-service owns the
    // Message row and the out-of-order/terminal-state guard logic.
    socket.on('message-status', (data: { messageId: string; status: string; failedReason?: string }) => {
      publish('message.ack.received', data).catch((err) => console.error('[device-gateway] publish ack failed:', err));
    });

    socket.on('incoming-message', async (data: { deviceId: string; from: string; fromWid?: string; body: string; waMessageId?: string }) => {
      try {
        console.log(`[device-gateway] Incoming message on ${data.deviceId} from ${data.from}`);
        const device = await prisma.device.findUnique({ where: { id: data.deviceId } });
        if (!device) {
          console.warn(`[device-gateway] Ignored incoming message for unknown/deleted device ${data.deviceId}`);
          return;
        }

        const contactResp = await fetch(`${CONTACT_URL}/internal/contacts/find-or-create`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: device.userId, phoneNumber: data.from }),
        });
        const contact = (await contactResp.json()) as { id: string; name: string; phoneNumber: string };

        publish('message.received', {
          deviceId: device.id, userId: device.userId, contactId: contact.id, contactName: contact.name, contactPhone: contact.phoneNumber,
          direction: 'inbound', content: data.body, waMessageId: data.waMessageId || null, fromWid: data.fromWid || null,
        }).catch((err) => console.error('[device-gateway] publish message.received failed:', err));
      } catch (err) {
        console.error('[device-gateway] Error handling incoming message:', err);
      }
    });
  });

  return io;
};

export const sendInitDevice = (deviceId: string) => {
  if (!gatewaySocket) {
    console.warn(`[device-gateway] Cannot init device ${deviceId}. WA worker is not connected!`);
    return false;
  }
  gatewaySocket.emit('init-device', { deviceId });
  return true;
};

export const sendLogoutDevice = (deviceId: string) => {
  if (!gatewaySocket) {
    console.warn(`[device-gateway] Cannot logout device ${deviceId}. WA worker is not connected!`);
    return false;
  }
  gatewaySocket.emit('logout-device', { deviceId });
  return true;
};

export const sendWhatsappMessage = (data: { messageId: string; deviceId: string; to: string; body: string; mediaUrl?: string }) => {
  if (!gatewaySocket) {
    console.warn('[device-gateway] Cannot send message. WA worker is not connected!');
    return false;
  }
  gatewaySocket.emit('send-message', data);
  return true;
};
