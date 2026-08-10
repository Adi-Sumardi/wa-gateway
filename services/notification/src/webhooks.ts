import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Ported from the monolith's socket.ts triggerWebhooks - scoped to the
// owning user's own active webhooks that subscribed to this event type.
export async function triggerWebhooks(userId: string, eventType: string, payload: any) {
  try {
    const webhooks = await prisma.webhook.findMany({ where: { isActive: true, userId } });
    for (const webhook of webhooks) {
      const allowedEvents = webhook.eventTypes as string[];
      if (!allowedEvents.includes(eventType)) continue;

      fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventType, data: payload, timestamp: new Date().toISOString() }),
      })
        .then(async (res) => {
          const text = await res.text();
          await prisma.webhookLog.create({ data: { webhookId: webhook.id, eventType, responseCode: res.status, payload: `Response: ${res.status} - Body: ${text.substring(0, 1000)}` } });
        })
        .catch(async (err) => {
          console.error(`[notification] Error calling webhook ${webhook.url}:`, err);
          await prisma.webhookLog.create({ data: { webhookId: webhook.id, eventType, responseCode: 0, payload: `Error: ${err.message}` } });
        });
    }
  } catch (err) {
    console.error('[notification] Error triggering webhooks:', err);
  }
}
