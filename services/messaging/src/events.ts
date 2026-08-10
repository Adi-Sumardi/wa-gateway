// Subscribes to the domain events published by device-gateway-service (the
// WA worker adapter) and turns them into this service's own Message rows +
// downstream events, mirroring what the monolith's socket.ts did inline.
import { MessageStatus, PrismaClient } from '@prisma/client';
import { subscribe, publish } from './_shared/events';

const prisma = new PrismaClient();
const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';
const CAMPAIGN_URL = process.env.CAMPAIGN_SERVICE_URL || 'http://campaign:6008';

const MESSAGE_STATUS_RANK: Record<MessageStatus, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export async function startEventSubscriptions() {
  await subscribe('message.received', async (data) => {
    try {
      if (data.waMessageId) {
        const existing = await prisma.message.findUnique({ where: { waMessageId: data.waMessageId } });
        if (existing) {
          console.log(`[messaging] Ignored duplicate incoming message (waMessageId=${data.waMessageId})`);
          return;
        }
      }

      const msg = await prisma.message.create({
        data: { deviceId: data.deviceId, contactId: data.contactId, direction: 'inbound', content: data.content, status: 'read', waMessageId: data.waMessageId || undefined },
      });

      publish('message.persisted', {
        id: msg.id, deviceId: msg.deviceId, userId: data.userId, contactId: msg.contactId, contactName: data.contactName, contactPhone: data.contactPhone,
        direction: msg.direction, content: msg.content, createdAt: msg.createdAt, fromWid: data.fromWid,
      }).catch((err) => console.error('[messaging] publish message.persisted failed:', err));
    } catch (err) {
      console.error('[messaging] Error handling message.received:', err);
    }
  });

  await subscribe('message.ack.received', async (data: { messageId: string; status: MessageStatus; failedReason?: string }) => {
    try {
      const rank = MESSAGE_STATUS_RANK[data.status] ?? 0;
      const statusesNotAhead = (Object.keys(MESSAGE_STATUS_RANK) as MessageStatus[]).filter((s) => MESSAGE_STATUS_RANK[s] <= rank);

      const result = await prisma.message.updateMany({
        where: { id: data.messageId, status: { in: statusesNotAhead } },
        data: { status: data.status, failedReason: data.failedReason || null },
      });
      if (result.count === 0) {
        // Not a real outbound Message - could be an ack for a WA Warmer
        // exchange (warmer-service owns those ids in its own DB), or a
        // genuinely stale/out-of-order/unknown ack.
        const WARMER_URL = process.env.WARMER_SERVICE_URL || 'http://warmer:6010';
        fetch(`${WARMER_URL}/internal/warmer-logs/${data.messageId}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: data.status, failedReason: data.failedReason }),
        }).catch((err) => console.error('[messaging] warmer ack forward failed:', err));
        console.log(`[messaging] Ignored stale/out-of-order/unknown ack (or forwarded to warmer): ${data.messageId} -> ${data.status}`);
        return;
      }

      const msg = await prisma.message.findUniqueOrThrow({ where: { id: data.messageId } });

      if (msg.broadcastId) {
        fetch(`${CAMPAIGN_URL}/internal/broadcast-targets/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ broadcastId: msg.broadcastId, contactId: msg.contactId, status: data.status, sentAt: data.status === 'sent' || data.status === 'delivered' ? new Date().toISOString() : undefined }),
        }).catch((err) => console.error('[messaging] notify campaign failed:', err));
      }

      const deviceResp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${msg.deviceId}`);
      const device = deviceResp.ok ? ((await deviceResp.json()) as any) : null;
      publish('message.status.updated', {
        id: msg.id, deviceId: msg.deviceId, userId: device?.userId, status: msg.status, failedReason: msg.failedReason,
        direction: msg.direction, content: msg.content, createdAt: msg.createdAt, contactId: msg.contactId,
      }).catch((err) => console.error('[messaging] publish message.status.updated failed:', err));
    } catch (err) {
      console.error('[messaging] Error handling message.ack.received:', err);
    }
  });
}
