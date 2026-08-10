import { subscribe } from './_shared/events';
import { emitToOwner } from './dashboardSocket';
import { triggerWebhooks } from './webhooks';

const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';
const CONTACT_URL = process.env.CONTACT_SERVICE_URL || 'http://contact:6006';

const deviceOwnerCache = new Map<string, string>();
async function resolveUserId(deviceId: string, provided?: string): Promise<string | undefined> {
  if (provided) return provided;
  if (deviceOwnerCache.has(deviceId)) return deviceOwnerCache.get(deviceId);
  try {
    const resp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${deviceId}`);
    if (!resp.ok) return undefined;
    const device = (await resp.json()) as any;
    deviceOwnerCache.set(deviceId, device.userId);
    return device.userId;
  } catch {
    return undefined;
  }
}

async function resolveContact(contactId?: string): Promise<{ name?: string; phoneNumber?: string }> {
  if (!contactId) return {};
  try {
    const resp = await fetch(`${CONTACT_URL}/internal/contacts/${contactId}`);
    if (!resp.ok) return {};
    const c = (await resp.json()) as any;
    return { name: c.name, phoneNumber: c.phoneNumber };
  } catch {
    return {};
  }
}

export async function startEventSubscriptions() {
  await subscribe('device.status.changed', async (data) => {
    emitToOwner(data.userId, 'device-status', data);
    triggerWebhooks(data.userId, 'device.status', { deviceId: data.deviceId, status: data.status, phoneNumber: data.phoneNumber, updatedAt: new Date().toISOString() });
  });

  await subscribe('device.qr.generated', async (data) => {
    emitToOwner(data.userId, 'device-qr', { deviceId: data.deviceId, qr: data.qr });
  });

  await subscribe('message.persisted', async (data) => {
    const userId = await resolveUserId(data.deviceId, data.userId);
    if (!userId) return;
    const contact = data.contactName ? { name: data.contactName, phoneNumber: data.contactPhone } : await resolveContact(data.contactId);
    const payload = { id: data.id, deviceId: data.deviceId, direction: data.direction, content: data.content, createdAt: data.createdAt, contactName: contact.name, contactPhone: contact.phoneNumber };
    emitToOwner(userId, 'new-message', payload);
    if (data.direction === 'inbound') {
      triggerWebhooks(userId, 'message.in', { message: { id: data.id, deviceId: data.deviceId, from: contact.phoneNumber, body: data.content, createdAt: data.createdAt } });
    }
  });

  await subscribe('message.status.updated', async (data) => {
    const userId = await resolveUserId(data.deviceId, data.userId);
    if (!userId) return;
    const contact = await resolveContact(data.contactId);
    emitToOwner(userId, 'message-status-update', { id: data.id, deviceId: data.deviceId, status: data.status, failedReason: data.failedReason, direction: data.direction, content: data.content, createdAt: data.createdAt, contactName: contact.name, contactPhone: contact.phoneNumber });
    triggerWebhooks(userId, 'message.status', { messageId: data.id, deviceId: data.deviceId, status: data.status, failedReason: data.failedReason, to: contact.phoneNumber, updatedAt: new Date().toISOString() });
  });

  await subscribe('ai.escalation.created', async (data) => {
    emitToOwner(data.userId, 'ai-escalation', data);
    triggerWebhooks(data.userId, 'ai.escalation', { deviceId: data.deviceId, contactPhone: data.contactPhone, question: data.question, reason: data.reason, createdAt: data.createdAt });
  });

  await subscribe('ai.credit.depleted', async (data) => {
    emitToOwner(data.userId, 'ai-credit-depleted', { deviceId: data.deviceId, deviceLabel: data.deviceLabel });
  });

  await subscribe('quota.updated', async (data) => {
    emitToOwner(data.userId, 'quota-updated', { productType: data.productType, newValue: data.newValue });
  });

  await subscribe('broadcast.status.changed', async (data) => {
    emitToOwner(data.userId, 'broadcast-status', { broadcastId: data.broadcastId, status: data.status });
  });

  await subscribe('warmer.log.created', async (data) => {
    emitToOwner(data.userId, 'warmer-log', data);
  });

  await subscribe('warmer.log.status', async (data) => {
    emitToOwner(data.userId, 'warmer-log-status', data);
  });
}
