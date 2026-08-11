import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { PrismaClient, Device, DeviceStatus, MessageStatus } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { hasBalance, consumeCredit } from './services/credit.service';

const prisma = new PrismaClient();
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'sendago-gateway-secret-token';
const JWT_SECRET = process.env.JWT_SECRET || 'sendago-super-secret-jwt-key';

// Matches common ways a customer might ask for the brochure/catalog, so the
// image can be attached deterministically instead of depending on the LLM
// remembering to mention it.
const BROCHURE_KEYWORDS = /brosur|brochure|katalog|catalog|pamflet|flyer/i;

// Folds the device's structured AI resources (website, price list) into the
// freeform aiContext so the model can naturally reference them in its reply.
function buildAiContext(device: Pick<Device, 'aiContext' | 'aiWebsiteUrl' | 'aiPriceList'>): string | undefined {
  const parts: string[] = [];
  if (device.aiContext) parts.push(device.aiContext);
  if (device.aiWebsiteUrl) {
    parts.push(`Website/link pendaftaran resmi: ${device.aiWebsiteUrl}. Sertakan link ini apabila pengguna menanyakan tentang pendaftaran atau website.`);
  }
  if (device.aiPriceList) {
    parts.push(`Daftar harga/biaya:\n${device.aiPriceList}\nGunakan informasi ini apabila pengguna menanyakan harga atau biaya.`);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

// Lifecycle order for outbound message status ACKs, used to reject
// out-of-order updates (e.g. a late 'sent' ack arriving after 'read').
// 'failed' is treated as terminal/final and always wins.
const MESSAGE_STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

let io: SocketServer | null = null;
let gatewaySocket: Socket | null = null;

// Map to track active dashboard socket connections
const dashboardSockets = new Set<Socket>();

export const initSocket = (server: HTTPServer) => {
  io = new SocketServer(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket: Socket) => {
    const authType = socket.handshake.auth?.type;
    const token = socket.handshake.auth?.token;

    if (authType === 'gateway') {
      // Validate gateway token
      if (token !== GATEWAY_TOKEN) {
        console.warn(`[Socket] Rejected gateway connection with invalid token: ${token}`);
        socket.disconnect();
        return;
      }

      console.log(`[Socket] Gateway connected: ${socket.id}`);
      gatewaySocket = socket;

      // Auto-restore and initialize all registered devices on gateway connection
      (async () => {
        try {
          const allDevices = await prisma.device.findMany();
          console.log(`[Socket] Restoring ${allDevices.length} registered devices in gateway memory...`);
          for (const dev of allDevices) {
            socket.emit('init-device', { deviceId: dev.id });
          }
        } catch (dbErr) {
          console.error('[Socket] Failed to load devices for gateway auto-restore:', dbErr);
        }
      })();

      // Handle gateway disconnect
      socket.on('disconnect', () => {
        console.log(`[Socket] Gateway disconnected: ${socket.id}`);
        if (gatewaySocket?.id === socket.id) {
          gatewaySocket = null;
        }
      });

      // Handle device status update from gateway
      socket.on('device-status', async (data: { deviceId: string; status: DeviceStatus; phoneNumber?: string }) => {
        console.log(`[Socket] Device status update: ${data.deviceId} -> ${data.status} (phone: ${data.phoneNumber})`);
        try {
          const device = await prisma.device.findUnique({ where: { id: data.deviceId }, select: { userId: true } });
          if (!device) {
            // Device was deleted (e.g. from the dashboard) while the gateway
            // still had it in memory and later emitted a status for it.
            console.warn(`[Socket] Ignored status update for unknown/deleted device ${data.deviceId}`);
            return;
          }

          await prisma.device.update({
            where: { id: data.deviceId },
            data: {
              status: data.status,
              phoneNumber: data.phoneNumber || undefined,
              lastConnectedAt: data.status === 'connected' ? new Date() : undefined,
            },
          });

          emitToOwner(device.userId, 'device-status', data);

          // Trigger Webhooks for device connection state changes
          triggerWebhooks(device.userId, 'device.status', {
            deviceId: data.deviceId,
            status: data.status,
            phoneNumber: data.phoneNumber || null,
            updatedAt: new Date().toISOString()
          });
        } catch (err) {
          console.error(`[Socket] Error updating device ${data.deviceId} status:`, err);
        }
      });

      // Handle QR code generation from gateway
      socket.on('device-qr', async (data: { deviceId: string; qr: string }) => {
        console.log(`[Socket] Received QR code for device: ${data.deviceId}`);
        try {
          const device = await prisma.device.findUnique({ where: { id: data.deviceId }, select: { userId: true } });
          if (!device) return;
          emitToOwner(device.userId, 'device-qr', data);
        } catch (err) {
          console.error(`[Socket] Error resolving owner for device-qr ${data.deviceId}:`, err);
        }
      });

      // Handle message status update from gateway
      socket.on('message-status', async (data: { messageId: string; status: MessageStatus; failedReason?: string }) => {
        console.log(`[Socket] Message status update: ${data.messageId} -> ${data.status}`);
        try {
          const rank = MESSAGE_STATUS_RANK[data.status] ?? 0;
          // ACK events from the gateway can arrive out of order (concurrent
          // async DB writes racing each other). Only apply this update if it
          // doesn't regress the message to an earlier point in its lifecycle
          // (e.g. a late 'sent' ack must not overwrite an already-'read'
          // message) - done atomically in the WHERE clause, not via a
          // separate read-then-write, to avoid a TOCTOU race between them.
          const statusesNotAhead = (Object.keys(MESSAGE_STATUS_RANK) as (keyof typeof MESSAGE_STATUS_RANK)[])
            .filter((s) => MESSAGE_STATUS_RANK[s] <= rank);

          const updateResult = await prisma.message.updateMany({
            where: { id: data.messageId, status: { in: statusesNotAhead } },
            data: {
              status: data.status,
              failedReason: data.failedReason || null,
            },
          });

          if (updateResult.count === 0) {
            // Not a real outbound Message - could be an ack for a WA Warmer
            // exchange, which is logged separately (warmer_logs) so internal
            // device-to-device chatter doesn't pollute real customer history.
            const warmerResult = await prisma.warmerLog.updateMany({
              where: { id: data.messageId, status: { in: statusesNotAhead } },
              data: { status: data.status, failedReason: data.failedReason || null },
            });
            if (warmerResult.count > 0) {
              const warmerLog = await prisma.warmerLog.findUnique({
                where: { id: data.messageId },
                include: { warmerSession: { select: { userId: true } } },
              });
              if (warmerLog) {
                emitToOwner(warmerLog.warmerSession.userId, 'warmer-log-status', { id: data.messageId, status: data.status });
              }
            } else {
              console.log(`[Socket] Ignored stale/out-of-order or unknown message status update: ${data.messageId} -> ${data.status}`);
            }
            return;
          }

          const updatedMsg = await prisma.message.findUniqueOrThrow({
            where: { id: data.messageId },
            include: { contact: true, device: true },
          });

          // If message is part of a broadcast, update target status too
          if (updatedMsg.broadcastId) {
            await prisma.broadcastTarget.updateMany({
              where: {
                broadcastId: updatedMsg.broadcastId,
                contactId: updatedMsg.contactId,
              },
              data: {
                status: data.status,
                sentAt: data.status === 'sent' || data.status === 'delivered' ? new Date() : undefined,
              },
            });

            // Recalculate and check if broadcast completed
            checkAndUpdateBroadcastStatus(updatedMsg.broadcastId);
          }

          // Broadcast status update to dashboards
          emitToOwner(updatedMsg.device.userId, 'message-status-update', {
            id: updatedMsg.id,
            deviceId: updatedMsg.deviceId,
            status: updatedMsg.status,
            failedReason: updatedMsg.failedReason,
            direction: updatedMsg.direction,
            content: updatedMsg.content,
            createdAt: updatedMsg.createdAt,
            contactName: updatedMsg.contact.name,
            contactPhone: updatedMsg.contact.phoneNumber,
          });

          // Trigger Webhooks for outbound message state changes
          triggerWebhooks(updatedMsg.device.userId, 'message.status', {
            messageId: updatedMsg.id,
            deviceId: updatedMsg.deviceId,
            status: updatedMsg.status,
            failedReason: updatedMsg.failedReason,
            to: updatedMsg.contact.phoneNumber,
            updatedAt: new Date().toISOString()
          });
        } catch (err) {
          console.error(`[Socket] Error updating message ${data.messageId}:`, err);
        }
      });

      // Handle incoming message from gateway
      socket.on('incoming-message', async (data: { deviceId: string; from: string; fromWid?: string; body: string; waMessageId?: string }) => {
        try {
          console.log(`[Socket] Incoming message on ${data.deviceId} from ${data.from}: ${(data.body || '').substring(0, 30)}`);

          // whatsapp-web.js can re-emit the same 'message' event after a
          // reconnect/session resync. Without a dedupe check this creates a
          // duplicate DB row and, if AI auto-reply is enabled, sends the
          // user two separate replies for one incoming message.
          if (data.waMessageId) {
            const existing = await prisma.message.findUnique({ where: { waMessageId: data.waMessageId } });
            if (existing) {
              console.log(`[Socket] Ignored duplicate incoming message (waMessageId=${data.waMessageId})`);
              return;
            }
          }

          // Find the device
          const device = await prisma.device.findUnique({
            where: { id: data.deviceId },
            include: { user: { select: { role: true } } },
          });

          if (!device) {
            console.warn(`[Socket] Ignored incoming message for unknown/deleted device ${data.deviceId}`);
            return;
          }

          // Find or create contact, scoped to the receiving device's owner
          let contact = await prisma.contact.findFirst({
            where: { userId: device.userId, phoneNumber: data.from },
          });

          if (!contact) {
            contact = await prisma.contact.create({
              data: {
                userId: device.userId,
                name: data.from, // fallback name
                phoneNumber: data.from,
              },
            });
          }

          // Save message to DB
          const msg = await prisma.message.create({
            data: {
              deviceId: data.deviceId,
              contactId: contact.id,
              direction: 'inbound',
              content: data.body,
              status: 'read', // incoming messages are default read
              waMessageId: data.waMessageId || undefined,
            },
          });

          // Broadcast new message to dashboard
          emitToOwner(device.userId, 'new-message', {
            id: msg.id,
            deviceId: msg.deviceId,
            direction: msg.direction,
            content: msg.content,
            createdAt: msg.createdAt,
            contactName: contact.name,
            contactPhone: contact.phoneNumber,
          });

          // Trigger Webhooks
          triggerWebhooks(device.userId, 'message.in', {
            message: {
              id: msg.id,
              deviceId: msg.deviceId,
              from: contact.phoneNumber,
              body: msg.content,
              createdAt: msg.createdAt,
            },
          });

          // If AI is enabled for this device, trigger auto-reply
          if (device && device.aiEnabled) {
            // Trigger in background to keep socket response fast
            (async () => {
              try {
                // A prior message from this same contact already stumped the
                // AI and is waiting on a human - stay completely silent
                // (no reply, no repeat holding message, no new escalation)
                // until an admin resolves it, instead of the bot cheerfully
                // trying again on every new message in the same
                // conversation. Resuming is automatic: once resolved, the
                // next inbound message finds no open row here and the AI
                // picks the conversation back up on its own.
                const openEscalation = await prisma.aiEscalation.findFirst({
                  where: { deviceId: device.id, contactId: contact.id, status: 'open' },
                  select: { id: true },
                });
                if (openEscalation) {
                  console.log(`[AI] Staying silent for ${data.from} - escalation ${openEscalation.id} still open, waiting on a human`);
                  return;
                }

                // Admin's own AI usage is unlimited/free, matching the
                // "admin bypasses" pattern used everywhere else in this app -
                // only metered for non-admin (member) device owners.
                const isMetered = device.user.role !== 'admin';
                if (isMetered && !(await hasBalance(device.userId))) {
                  console.log(`[Credit] Skipping AI reply for device ${device.id}: balance is 0`);
                  emitToOwner(device.userId, 'ai-credit-depleted', { deviceId: device.id, deviceLabel: device.label });
                  return;
                }

                // Natural typing delay of 1.5s
                await new Promise(resolve => setTimeout(resolve, 1500));

                const enrichedContext = buildAiContext(device);
                const aiResult = await callAiChatbot(data.body, enrichedContext);
                const recipient = data.fromWid || (data.from + '@c.us');

                if (aiResult.status === 'no_reply') {
                  // The model decided this wasn't a genuine question (e.g. an
                  // automated greeting from another WhatsApp Business account) -
                  // stay silent instead of replying to a robot. Abstaining costs
                  // nothing since no OpenAI-generated reply was actually sent.
                  console.log(`[AI] Abstained from replying to ${data.from} (not a genuine question)`);
                } else if (aiResult.status === 'error' || aiResult.status === 'uncertain') {
                  // The AI either failed technically (no API key, request/parse
                  // error) or explicitly signaled it can't answer confidently
                  // from the context it was given. Either way, don't let a
                  // canned "maaf saya tidak mengerti" string masquerade as a
                  // real answer (and don't bill AI credit for it) - send a
                  // human holding reply instead and raise an escalation so a
                  // human operator picks up the conversation.
                  console.warn(`[AI] Escalating to human for ${data.from} (reason=${aiResult.status}): ${aiResult.detail}`);

                  const holdingReply = 'Mohon maaf, pertanyaan Anda akan segera dibantu oleh tim kami secara langsung ya 🙏';
                  const outMsg = await prisma.message.create({
                    data: {
                      deviceId: device.id,
                      contactId: contact.id,
                      direction: 'outbound',
                      content: holdingReply,
                      status: 'queued',
                    },
                  });
                  sendWhatsappMessage({
                    messageId: outMsg.id,
                    deviceId: device.id,
                    to: recipient,
                    body: holdingReply,
                  });

                  const escalation = await prisma.aiEscalation.create({
                    data: {
                      userId: device.userId,
                      deviceId: device.id,
                      contactId: contact.id,
                      messageId: msg.id,
                      question: data.body,
                      reason: aiResult.status === 'error' ? 'ai_error' : 'ai_uncertain',
                      detail: aiResult.detail,
                    },
                  });

                  emitToOwner(device.userId, 'ai-escalation', {
                    id: escalation.id,
                    deviceId: device.id,
                    deviceLabel: device.label,
                    contactId: contact.id,
                    contactName: contact.name,
                    contactPhone: contact.phoneNumber,
                    question: data.body,
                    reason: escalation.reason,
                    createdAt: escalation.createdAt,
                  });

                  triggerWebhooks(device.userId, 'ai.escalation', {
                    deviceId: device.id,
                    contactPhone: contact.phoneNumber,
                    question: data.body,
                    reason: escalation.reason,
                    createdAt: escalation.createdAt.toISOString(),
                  });
                } else {
                  const aiReply = aiResult.text;
                  if (isMetered) {
                    const newBalance = await consumeCredit(device.userId);
                    // Push the updated balance live - without this the
                    // dashboard only shows the new number after a manual
                    // reload, even though it was already deducted correctly.
                    if (newBalance !== null) {
                      emitToOwner(device.userId, 'quota-updated', { productType: 'ai_credit', newValue: newBalance });
                    }
                  }
                  // Create outbound message in DB
                  const outMsg = await prisma.message.create({
                    data: {
                      deviceId: device.id,
                      contactId: contact.id,
                      direction: 'outbound',
                      content: aiReply,
                      status: 'queued',
                    },
                  });

                  // Dispatch message to gateway
                  const dispatched = sendWhatsappMessage({
                    messageId: outMsg.id,
                    deviceId: device.id,
                    // Reply to the exact WID WhatsApp reported for the sender
                    // (handles the newer @lid privacy identifier, not just
                    // classic phone-based @c.us ids). Fall back for older
                    // gateway builds that don't send fromWid yet.
                    to: recipient,
                    body: aiReply,
                  });

                  // If the gateway isn't connected, the message would
                  // otherwise sit at 'queued' forever with no ACK ever
                  // arriving to correct it - mark it failed immediately so
                  // it surfaces in the dashboard instead of looking sent.
                  if (!dispatched) {
                    await prisma.message.update({
                      where: { id: outMsg.id },
                      data: { status: 'failed', failedReason: 'Gateway not connected' },
                    });
                    emitToOwner(device.userId, 'message-status-update', {
                      id: outMsg.id,
                      deviceId: device.id,
                      status: 'failed',
                      failedReason: 'Gateway not connected',
                      direction: 'outbound',
                      content: aiReply,
                      createdAt: outMsg.createdAt,
                      contactName: contact.name,
                      contactPhone: contact.phoneNumber,
                    });
                  }
                }

                // Deterministic (not LLM-dependent) brochure attachment: if the
                // incoming message looks like a request for the brochure/catalog
                // and one is configured, send it as a separate image/file message.
                if (device.aiBrochureUrl && BROCHURE_KEYWORDS.test(data.body || '')) {
                  const brochureMsg = await prisma.message.create({
                    data: {
                      deviceId: device.id,
                      contactId: contact.id,
                      direction: 'outbound',
                      content: '[Brosur]',
                      mediaUrl: device.aiBrochureUrl,
                      status: 'queued',
                    },
                  });
                  sendWhatsappMessage({
                    messageId: brochureMsg.id,
                    deviceId: device.id,
                    to: recipient,
                    body: '',
                    mediaUrl: device.aiBrochureUrl,
                  });
                }
              } catch (aiErr) {
                console.error('[Socket] AI auto-reply execution error:', aiErr);
              }
            })();
          }
        } catch (err) {
          console.error('[Socket] Error handling incoming message:', err);
        }
      });

    } else {
      // Connects from dashboard client - must present a valid JWT so we can
      // scope real-time events to their own room (and admins to everyone's).
      let decoded: { id: string; email: string; role: string };
      try {
        decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; role: string };
      } catch {
        console.warn(`[Socket] Rejected dashboard connection with invalid/missing token: ${socket.id}`);
        socket.disconnect();
        return;
      }

      console.log(`[Socket] Dashboard client connected: ${socket.id} (user ${decoded.id})`);
      socket.join(`user:${decoded.id}`);
      if (decoded.role === 'admin') {
        socket.join('admin');
      }
      dashboardSockets.add(socket);

      socket.on('disconnect', () => {
        console.log(`[Socket] Dashboard client disconnected: ${socket.id}`);
        dashboardSockets.delete(socket);
      });
    }
  });

  return io;
};

// Helper function to check and update broadcast status. Exported so
// broadcast.service.ts can also call it for targets that fail before ever
// reaching the gateway (e.g. no connected device at dispatch time) - those
// never produce a 'message-status' ack, which is the only other place this
// check normally runs from.
export async function checkAndUpdateBroadcastStatus(broadcastId: string) {
  const targets = await prisma.broadcastTarget.findMany({
    where: { broadcastId },
  });

  const allDone = targets.every(t => ['sent', 'delivered', 'read', 'failed'].includes(t.status));
  const hasFailed = targets.some(t => t.status === 'failed');

  if (allDone) {
    // Two 'message-status' events for different targets of the same
    // broadcast can each reach "all done" and race here. Guard the flip to
    // a terminal state atomically in the WHERE clause so only the first
    // caller actually applies it and emits the notification - otherwise
    // both would double-fire 'broadcast-status' to the dashboard.
    const result = await prisma.broadcast.updateMany({
      where: { id: broadcastId, status: { notIn: ['completed', 'failed'] } },
      data: {
        status: hasFailed ? 'failed' : 'completed',
      },
    });

    if (result.count === 0) return;

    const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId }, select: { createdBy: true } });
    if (!broadcast) return;

    emitToOwner(broadcast.createdBy, 'broadcast-status', {
      broadcastId,
      status: hasFailed ? 'failed' : 'completed',
    });
  }
}

// Helper to trigger webhooks - scoped to the owning user's own webhooks only.
export async function triggerWebhooks(userId: string, eventType: string, payload: any) {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: { isActive: true, userId },
    });

    for (const webhook of webhooks) {
      const allowedEvents = webhook.eventTypes as string[];
      if (allowedEvents.includes(eventType)) {
        // Send async POST request to webhook url
        fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event: eventType,
            data: payload,
            timestamp: new Date().toISOString(),
          }),
        })
          .then(async (res) => {
            const status = res.status;
            const text = await res.text();
            // Log webhook call
            await prisma.webhookLog.create({
              data: {
                webhookId: webhook.id,
                eventType,
                responseCode: status,
                payload: `Response: ${status} - Body: ${text.substring(0, 1000)}`,
              },
            });
          })
          .catch(async (err) => {
            console.error(`[Webhook] Error calling ${webhook.url}:`, err);
            await prisma.webhookLog.create({
              data: {
                webhookId: webhook.id,
                eventType,
                responseCode: 0,
                payload: `Error: ${err.message}`,
              },
            });
          });
      }
    }
  } catch (err) {
    console.error('[Webhook] Error triggering webhooks:', err);
  }
}

// Send init-device command to gateway
export const sendInitDevice = (deviceId: string) => {
  if (!gatewaySocket) {
    console.warn(`[Socket] Cannot init device ${deviceId}. Gateway is not connected!`);
    return false;
  }
  gatewaySocket.emit('init-device', { deviceId });
  return true;
};

// Send logout-device command to gateway
export const sendLogoutDevice = (deviceId: string) => {
  if (!gatewaySocket) {
    console.warn(`[Socket] Cannot logout device ${deviceId}. Gateway is not connected!`);
    return false;
  }
  gatewaySocket.emit('logout-device', { deviceId });
  return true;
};

// Emit an event to a resource owner's dashboard sockets and to every admin
// (used both internally above and by services outside this module, e.g.
// warmer.service.ts, that don't have direct access to `io`).
export const emitToOwner = (userId: string, event: string, payload: any) => {
  io?.to(`user:${userId}`).to('admin').emit(event, payload);
};

// Send message send directive to gateway
export const sendWhatsappMessage = (data: { messageId: string; deviceId: string; to: string; body: string; mediaUrl?: string }) => {
  if (!gatewaySocket) {
    console.warn(`[Socket] Cannot send message. Gateway is not connected!`);
    return false;
  }
  gatewaySocket.emit('send-message', data);
  return true;
};


// Helper function to query AI API (supports OpenAI ChatGPT and Google Gemini)
// Returned verbatim by the model (see ABSTAIN_INSTRUCTION below) when the
// incoming message isn't a genuine question from a person - e.g. another
// WhatsApp Business account's automated greeting/away message - so the bot
// stays silent instead of replying to a robot.
const NO_REPLY_SENTINEL = 'NO_REPLY';

// Returned verbatim by the model when it doesn't have enough information
// (from its own knowledge + the device's configured aiContext) to answer the
// customer's question confidently - e.g. account-specific requests (order
// status, refunds, complaints) or questions outside the given business
// context. Distinguishing this from a genuine answer is what lets the caller
// hand the conversation to a human instead of guessing/hallucinating.
const NEED_HUMAN_SENTINEL = 'NEED_HUMAN';

const ABSTAIN_INSTRUCTION = `Anda adalah asisten balas otomatis WhatsApp untuk sebuah bisnis. Balas SEMUA pesan dari calon pelanggan secara normal dan ramah - termasuk sapaan singkat seperti "halo", "hi", "assalamualaikum", "min", "p", dll. Sapaan singkat seperti itu adalah hal wajar dari manusia dan HARUS tetap dibalas seperti biasa (misalnya dengan salam balik dan menawarkan bantuan).

HANYA diam (jangan membalas kalimat apapun, balas HANYA dengan teks persis "${NO_REPLY_SENTINEL}") apabila pesan yang masuk SANGAT JELAS merupakan pesan otomatis dari sistem lain, dicirikan dengan kalimat baku seperti "terima kasih telah menghubungi", "pesan ini dikirim secara otomatis", "balasan otomatis", "kami akan segera merespon", "di luar jam operasional", "auto reply", atau notifikasi sistem (bukan kalimat personal). Jika ragu apakah suatu pesan otomatis atau bukan, JANGAN diam - tetap balas seperti biasa.

Apabila pesan adalah pertanyaan sungguhan dari calon pelanggan TETAPI Anda TIDAK memiliki cukup informasi untuk menjawabnya dengan yakin dan akurat (misalnya menanyakan status pesanan/transaksi spesifik, komplain, refund, permintaan bicara dengan manusia/CS, atau hal di luar konteks bisnis yang diberikan ke Anda) - JANGAN mengarang jawaban. Balas HANYA dengan teks persis "${NEED_HUMAN_SENTINEL}" agar percakapan diteruskan ke tim manusia.`;

type AiResult =
  | { status: 'ok'; text: string }
  | { status: 'no_reply' }
  | { status: 'uncertain'; detail: string }
  | { status: 'error'; detail: string };

const AI_REQUEST_TIMEOUT_MS = 20000;

async function callAiChatbot(prompt: string, context?: string): Promise<AiResult> {
  const openAiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const systemContent = context ? `${ABSTAIN_INSTRUCTION}\n\n${context}` : ABSTAIN_INSTRUCTION;

  const interpret = (aiText: string | undefined, providerLabel: string): AiResult => {
    if (!aiText) {
      return { status: 'error', detail: `${providerLabel} returned an empty/unparseable response` };
    }
    const trimmed = aiText.trim();
    if (trimmed.toUpperCase() === NO_REPLY_SENTINEL) {
      return { status: 'no_reply' };
    }
    if (trimmed.toUpperCase() === NEED_HUMAN_SENTINEL) {
      return { status: 'uncertain', detail: 'Model signaled it lacks enough context to answer confidently' };
    }
    return { status: 'ok', text: trimmed };
  };

  if (openAiKey) {
    try {
      console.log('[AI] Querying OpenAI API...');
      const messages = [{ role: 'system', content: systemContent }, { role: 'user', content: prompt }];

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openAiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const bodyText = await response.text();
        console.error(`[OpenAI] Request failed with status ${response.status}:`, bodyText.substring(0, 500));
        return { status: 'error', detail: `OpenAI HTTP ${response.status}` };
      }

      const resJson = (await response.json()) as any;
      const aiText = resJson.choices?.[0]?.message?.content;
      if (!aiText) {
        console.error('[OpenAI] Response parse error. Full response:', JSON.stringify(resJson));
      }
      return interpret(aiText, 'OpenAI');
    } catch (err: any) {
      console.error('[OpenAI] Request failed:', err);
      return { status: 'error', detail: err?.name === 'AbortError' ? 'OpenAI request timed out' : `OpenAI request failed: ${err?.message}` };
    }
  }

  if (geminiKey) {
    try {
      console.log('[AI] Querying Gemini API...');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemContent }] },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const bodyText = await response.text();
        console.error(`[Gemini] Request failed with status ${response.status}:`, bodyText.substring(0, 500));
        return { status: 'error', detail: `Gemini HTTP ${response.status}` };
      }

      const resJson = (await response.json()) as any;
      const aiText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiText) {
        console.error('[Gemini] Response parse error. Full response:', JSON.stringify(resJson));
      }
      return interpret(aiText, 'Gemini');
    } catch (err: any) {
      console.error('[Gemini] Request failed:', err);
      return { status: 'error', detail: err?.name === 'AbortError' ? 'Gemini request timed out' : `Gemini request failed: ${err?.message}` };
    }
  }

  console.warn('[AI] Neither OPENAI_API_KEY nor GEMINI_API_KEY is configured.');
  return { status: 'error', detail: 'No AI provider API key configured' };
}
