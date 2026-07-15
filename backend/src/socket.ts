import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { PrismaClient, DeviceStatus } from '@prisma/client';

const prisma = new PrismaClient();
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'sendago-gateway-secret-token';

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
          await prisma.device.update({
            where: { id: data.deviceId },
            data: {
              status: data.status,
              phoneNumber: data.phoneNumber || undefined,
              lastConnectedAt: data.status === 'connected' ? new Date() : undefined,
            },
          });
          // Broadcast to all dashboard clients
          io?.to('dashboard').emit('device-status', data);

          // Trigger Webhooks for device connection state changes
          triggerWebhooks('device.status', {
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
      socket.on('device-qr', (data: { deviceId: string; qr: string }) => {
        console.log(`[Socket] Received QR code for device: ${data.deviceId}`);
        // Broadcast to all dashboard clients
        io?.to('dashboard').emit('device-qr', data);
      });

      // Handle message status update from gateway
      socket.on('message-status', async (data: { messageId: string; status: any; failedReason?: string }) => {
        console.log(`[Socket] Message status update: ${data.messageId} -> ${data.status}`);
        try {
          const updatedMsg = await prisma.message.update({
            where: { id: data.messageId },
            data: {
              status: data.status,
              failedReason: data.failedReason || null,
            },
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
          io?.to('dashboard').emit('message-status-update', {
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
          triggerWebhooks('message.status', {
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
      socket.on('incoming-message', async (data: { deviceId: string; from: string; body: string }) => {
        console.log(`[Socket] Incoming message on ${data.deviceId} from ${data.from}: ${data.body.substring(0, 30)}`);
        try {
          // Find the device
          const device = await prisma.device.findUnique({
            where: { id: data.deviceId }
          });

          // Find or create contact
          let contact = await prisma.contact.findUnique({
            where: { phoneNumber: data.from },
          });

          if (!contact) {
            contact = await prisma.contact.create({
              data: {
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
            },
          });

          // Broadcast new message to dashboard
          io?.to('dashboard').emit('new-message', {
            id: msg.id,
            deviceId: msg.deviceId,
            direction: msg.direction,
            content: msg.content,
            createdAt: msg.createdAt,
            contactName: contact.name,
            contactPhone: contact.phoneNumber,
          });

          // Trigger Webhooks
          triggerWebhooks('message.in', {
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
                // Natural typing delay of 1.5s
                await new Promise(resolve => setTimeout(resolve, 1500));

                const aiReply = await callAiChatbot(data.body, device.aiContext || undefined);

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
                sendWhatsappMessage({
                  messageId: outMsg.id,
                  deviceId: device.id,
                  to: data.from + '@c.us',
                  body: aiReply,
                });
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
      // Connects from dashboard client
      console.log(`[Socket] Dashboard client connected: ${socket.id}`);
      socket.join('dashboard');
      dashboardSockets.add(socket);

      socket.on('disconnect', () => {
        console.log(`[Socket] Dashboard client disconnected: ${socket.id}`);
        dashboardSockets.delete(socket);
      });
    }
  });

  return io;
};

// Helper function to check and update broadcast status
async function checkAndUpdateBroadcastStatus(broadcastId: string) {
  const targets = await prisma.broadcastTarget.findMany({
    where: { broadcastId },
  });

  const allDone = targets.every(t => ['sent', 'delivered', 'read', 'failed'].includes(t.status));
  const hasFailed = targets.some(t => t.status === 'failed');

  if (allDone) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: hasFailed ? 'failed' : 'completed',
      },
    });

    // Notify dashboard
    io?.to('dashboard').emit('broadcast-status', {
      broadcastId,
      status: hasFailed ? 'failed' : 'completed',
    });
  }
}

// Helper to trigger webhooks
export async function triggerWebhooks(eventType: string, payload: any) {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: { isActive: true },
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
async function callAiChatbot(prompt: string, context?: string): Promise<string> {
  const openAiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (openAiKey) {
    try {
      console.log('[AI] Querying OpenAI API...');
      const messages = [];
      if (context) {
        messages.push({ role: 'system', content: context });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openAiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
        }),
      });

      const resJson = (await response.json()) as any;
      const aiText = resJson.choices?.[0]?.message?.content;
      if (aiText) {
        return aiText.trim();
      }
      console.error('[OpenAI] Response parse error. Full response:', JSON.stringify(resJson));
      return 'Maaf, saya tidak dapat memahami pesan tersebut saat ini.';
    } catch (err) {
      console.error('[OpenAI] Request failed:', err);
      return 'Maaf, asisten virtual sedang offline. Silakan coba kembali nanti.';
    }
  }

  if (geminiKey) {
    try {
      console.log('[AI] Querying Gemini API...');
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          systemInstruction: context ? { parts: [{ text: context }] } : undefined,
        }),
      });

      const resJson = (await response.json()) as any;
      const aiText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
      if (aiText) {
        return aiText.trim();
      }
      console.error('[Gemini] Response parse error. Full response:', JSON.stringify(resJson));
      return 'Maaf, saya tidak dapat memahami pesan tersebut saat ini.';
    } catch (err) {
      console.error('[Gemini] Request failed:', err);
      return 'Maaf, asisten virtual sedang offline. Silakan coba kembali nanti.';
    }
  }

  console.warn('[AI] Neither OPENAI_API_KEY nor GEMINI_API_KEY is configured.');
  return 'Maaf, sistem AI Chatbot sedang tidak aktif (kunci API tidak dikonfigurasi).';
}
