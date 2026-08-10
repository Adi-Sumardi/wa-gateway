// The core "does the AI answer or does a human need to?" flow - ported from
// backend/src/socket.ts's incoming-message handler, split into its own
// service and driven by the message.persisted event instead of running
// inline in the socket handler.
import { PrismaClient } from '@prisma/client';
import { subscribe, publish } from './_shared/events';
import { callAiChatbot, buildAiContext, BROCHURE_KEYWORDS } from './ai';

const prisma = new PrismaClient();
const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';
const MESSAGING_URL = process.env.MESSAGING_SERVICE_URL || 'http://messaging:6003';
const IDENTITY_URL = process.env.IDENTITY_SERVICE_URL || 'http://identity:6001';
const BILLING_URL = process.env.BILLING_SERVICE_URL || 'http://billing:6009';

interface MessagePersistedEvent {
  id: string; deviceId: string; userId?: string; contactId: string; contactName?: string; contactPhone?: string;
  direction: 'inbound' | 'outbound'; content: string; createdAt: string; fromWid?: string;
}

async function sendReply(deviceId: string, contactId: string, userId: string, recipient: string, content: string, mediaUrl?: string, waBody?: string) {
  const createResp = await fetch(`${MESSAGING_URL}/internal/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, contactId, direction: 'outbound', content, mediaUrl, status: 'queued', userId }),
  });
  const msg = (await createResp.json()) as { id: string; createdAt: string };
  const sendResp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${deviceId}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: msg.id, to: recipient, body: waBody !== undefined ? waBody : content, mediaUrl }),
  });
  const dispatched = sendResp.ok && ((await sendResp.json()) as any).dispatched === true;
  if (!dispatched) {
    await fetch(`${MESSAGING_URL}/internal/messages/${msg.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed', failedReason: 'Gateway not connected' }),
    }).catch((err) => console.error('[conversation-ai] failed to mark message failed:', err));
  }
  return { messageId: msg.id, dispatched };
}

export async function startEventSubscriptions() {
  await subscribe('message.persisted', async (data: MessagePersistedEvent) => {
    if (data.direction !== 'inbound') return; // ignore our own outbound writes

    try {
      const deviceResp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${data.deviceId}`);
      if (!deviceResp.ok) return;
      const device = (await deviceResp.json()) as any;
      if (!device.aiEnabled) return;

      const userResp = await fetch(`${IDENTITY_URL}/internal/users/${device.userId}`);
      const user = userResp.ok ? ((await userResp.json()) as any) : null;
      const isMetered = user?.role !== 'admin';

      if (isMetered) {
        const balResp = await fetch(`${BILLING_URL}/internal/quota/${device.userId}/ai-credit/check`);
        const bal = balResp.ok ? ((await balResp.json()) as any) : { hasBalance: false };
        if (!bal.hasBalance) {
          console.log(`[conversation-ai] Skipping AI reply for device ${device.id}: balance is 0`);
          publish('ai.credit.depleted', { userId: device.userId, deviceId: device.id, deviceLabel: device.label }).catch((e) => console.error(e));
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1500)); // natural typing delay

      const enrichedContext = buildAiContext(device);
      const aiResult = await callAiChatbot(data.content, enrichedContext);
      const recipient = data.fromWid || `${data.contactPhone}@c.us`;

      if (aiResult.status === 'no_reply') {
        console.log(`[conversation-ai] Abstained from replying to ${data.contactPhone} (not a genuine question)`);
      } else if (aiResult.status === 'error' || aiResult.status === 'uncertain') {
        console.warn(`[conversation-ai] Escalating to human for ${data.contactPhone} (reason=${aiResult.status}): ${aiResult.detail}`);

        const holdingReply = 'Mohon maaf, pertanyaan Anda akan segera dibantu oleh tim kami secara langsung ya 🙏';
        await sendReply(device.id, data.contactId, device.userId, recipient, holdingReply);

        const escalation = await prisma.aiEscalation.create({
          data: { userId: device.userId, deviceId: device.id, contactId: data.contactId, messageId: data.id, question: data.content, reason: aiResult.status === 'error' ? 'ai_error' : 'ai_uncertain', detail: aiResult.detail },
        });

        publish('ai.escalation.created', {
          id: escalation.id, userId: device.userId, deviceId: device.id, deviceLabel: device.label,
          contactId: data.contactId, contactName: data.contactName, contactPhone: data.contactPhone,
          question: data.content, reason: escalation.reason, createdAt: escalation.createdAt,
        }).catch((err) => console.error('[conversation-ai] publish ai.escalation.created failed:', err));
      } else {
        const aiReply = aiResult.text;
        if (isMetered) {
          const consumeResp = await fetch(`${BILLING_URL}/internal/quota/${device.userId}/ai-credit/consume`, { method: 'POST' });
          const consumed = consumeResp.ok ? ((await consumeResp.json()) as any) : { newBalance: null };
          if (consumed.newBalance !== null) {
            publish('quota.updated', { userId: device.userId, productType: 'ai_credit', newValue: consumed.newBalance }).catch((e) => console.error(e));
          }
        }
        await sendReply(device.id, data.contactId, device.userId, recipient, aiReply);
      }

      if (device.aiBrochureUrl && BROCHURE_KEYWORDS.test(data.content || '')) {
        await sendReply(device.id, data.contactId, device.userId, recipient, '[Brosur]', device.aiBrochureUrl, '');
      }
    } catch (err) {
      console.error('[conversation-ai] AI auto-reply execution error:', err);
    }
  });
}
