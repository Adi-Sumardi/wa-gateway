// Ported from the monolith's broadcast.service.ts. Device/Template/Contact/
// Message ownership now lives in other services, so each step that used to
// be a local Prisma join is an HTTP call to the owning service instead.
import { PrismaClient } from '@prisma/client';
import { publish } from './_shared/events';

const prisma = new PrismaClient();
const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';
const MESSAGING_URL = process.env.MESSAGING_SERVICE_URL || 'http://messaging:6003';
const TEMPLATE_URL = process.env.TEMPLATE_SERVICE_URL || 'http://template:6007';
const CONTACT_URL = process.env.CONTACT_SERVICE_URL || 'http://contact:6006';

const activeTimers = new Map<string, NodeJS.Timeout>();

export const formatPhoneNumber = (num: string): string => {
  let cleaned = num.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.substring(1);
  if (!cleaned.endsWith('@c.us')) cleaned = cleaned + '@c.us';
  return cleaned;
};

const randomDelayMs = (minSeconds: number, maxSeconds: number) => {
  const min = Math.min(minSeconds, maxSeconds);
  const max = Math.max(minSeconds, maxSeconds);
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
};

const isInSleepWindow = (hour: number, sleepStart: number, sleepEnd: number) => {
  if (sleepStart === sleepEnd) return false;
  if (sleepStart < sleepEnd) return hour >= sleepStart && hour < sleepEnd;
  return hour >= sleepStart || hour < sleepEnd;
};

async function getDevice(deviceId: string) {
  const resp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${deviceId}`);
  if (!resp.ok) return null;
  return resp.json() as Promise<{ id: string; status: string; userId: string; lastConnectedAt: string | null }>;
}

async function pickRotatingDevice(userId: string) {
  const resp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices?ownerId=${userId}&status=connected&pickRotating=true`);
  if (!resp.ok) return null;
  const device = (await resp.json()) as any;
  return device?.id ? device : null;
}

async function dispatchMessage(params: { deviceId: string; contactId: string; broadcastId: string; content: string; mediaUrl?: string; to: string }) {
  const createResp = await fetch(`${MESSAGING_URL}/internal/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: params.deviceId, contactId: params.contactId, broadcastId: params.broadcastId, direction: 'outbound', content: params.content, mediaUrl: params.mediaUrl, status: 'queued' }),
  });
  const msg = (await createResp.json()) as { id: string };

  const sendResp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${params.deviceId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: msg.id, to: params.to, body: params.content, mediaUrl: params.mediaUrl }),
  });
  const dispatched = sendResp.ok && ((await sendResp.json()) as any).dispatched === true;
  return { messageId: msg.id, dispatched };
}

export async function createBroadcast(params: {
  userId: string; isAdmin?: boolean; name: string; content?: string; mediaUrl?: string; deviceId: string;
  rotateDevices: boolean; phoneNumbers: string[]; delayMinSeconds?: number; delayMaxSeconds?: number;
  sleepEnabled?: boolean; sleepStart?: number; sleepEnd?: number; scheduledAt?: Date; templateId?: string;
}) {
  const device = await getDevice(params.deviceId);
  if (!device || (!params.isAdmin && device.userId !== params.userId)) {
    throw new Error('Selected device not found or does not belong to you');
  }

  const uniqueNumbers = Array.from(new Set(params.phoneNumbers.map((n) => n.trim()).filter(Boolean)));
  const contactIds: string[] = [];
  for (const rawNumber of uniqueNumbers) {
    const formatted = formatPhoneNumber(rawNumber);
    const standardNumberOnly = formatted.replace('@c.us', '');
    const resp = await fetch(`${CONTACT_URL}/internal/contacts/find-or-create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: params.userId, phoneNumber: standardNumberOnly }),
    });
    const contact = (await resp.json()) as { id: string; optedOut: boolean };
    if (contact.optedOut) continue;
    contactIds.push(contact.id);
  }
  if (contactIds.length === 0) throw new Error('No valid, non-opted-out recipients in the provided list');

  let templateId: string;
  if (params.templateId) {
    const resp = await fetch(`${TEMPLATE_URL}/internal/templates/${params.templateId}`);
    if (!resp.ok) throw new Error('Selected template not found or does not belong to you');
    templateId = params.templateId;
  } else {
    if (!params.content) throw new Error('Either "content" or "templateId" is required');
    const resp = await fetch(`${TEMPLATE_URL}/internal/templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: params.userId, name: `[broadcast] ${params.name}`, content: params.content, mediaUrl: params.mediaUrl || null, mediaType: params.mediaUrl ? 'document' : 'none' }),
    });
    templateId = ((await resp.json()) as { id: string }).id;
  }

  const broadcast = await prisma.broadcast.create({
    data: {
      name: params.name, templateId, deviceId: device.id, createdBy: params.userId,
      status: params.scheduledAt ? 'scheduled' : 'draft', scheduledAt: params.scheduledAt || null,
      delayMinSeconds: params.delayMinSeconds ?? 5, delayMaxSeconds: params.delayMaxSeconds ?? 15,
      sleepEnabled: params.sleepEnabled ?? false, sleepStart: params.sleepStart ?? 22, sleepEnd: params.sleepEnd ?? 7,
      rotateDevices: params.rotateDevices,
      targets: { create: contactIds.map((contactId) => ({ contactId, status: 'queued' as const })) },
    },
    include: { targets: true },
  });
  return broadcast;
}

export const pauseBroadcast = async (broadcastId: string) => {
  const timer = activeTimers.get(broadcastId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(broadcastId);
  }
  await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'paused' } });
};

export const startBroadcast = async (broadcastId: string) => {
  if (activeTimers.has(broadcastId)) return;
  const result = await prisma.broadcast.updateMany({ where: { id: broadcastId, status: { notIn: ['completed'] } }, data: { status: 'running' } });
  if (result.count === 0) return;
  scheduleTick(broadcastId, 0);
};

const scheduleTick = (broadcastId: string, delayMs: number) => {
  activeTimers.set(broadcastId, setTimeout(() => dispatchNext(broadcastId), delayMs));
};

export async function checkAndUpdateBroadcastStatus(broadcastId: string) {
  const targets = await prisma.broadcastTarget.findMany({ where: { broadcastId } });
  const allDone = targets.every((t) => ['sent', 'delivered', 'read', 'failed'].includes(t.status));
  const hasFailed = targets.some((t) => t.status === 'failed');
  if (!allDone) return;

  const result = await prisma.broadcast.updateMany({ where: { id: broadcastId, status: { notIn: ['completed', 'failed'] } }, data: { status: hasFailed ? 'failed' : 'completed' } });
  if (result.count === 0) return;

  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId }, select: { createdBy: true } });
  if (!broadcast) return;
  publish('broadcast.status.changed', { userId: broadcast.createdBy, broadcastId, status: hasFailed ? 'failed' : 'completed' }).catch((err) => console.error('[campaign] publish failed:', err));
}

async function dispatchNext(broadcastId: string) {
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast || broadcast.status !== 'running') {
    activeTimers.delete(broadcastId);
    return;
  }

  if (broadcast.sleepEnabled && isInSleepWindow(new Date().getHours(), broadcast.sleepStart, broadcast.sleepEnd)) {
    scheduleTick(broadcastId, 60_000);
    return;
  }

  const nextTarget = await prisma.broadcastTarget.findFirst({ where: { broadcastId, status: 'queued' }, orderBy: { id: 'asc' } });
  if (!nextTarget) {
    activeTimers.delete(broadcastId);
    return;
  }

  const device = broadcast.rotateDevices ? await pickRotatingDevice(broadcast.createdBy) : await getDevice(broadcast.deviceId);
  if (!device || device.status !== 'connected') {
    await prisma.broadcastTarget.update({ where: { id: nextTarget.id }, data: { status: 'failed', failedReason: 'No connected device available at send time' } });
    await checkAndUpdateBroadcastStatus(broadcastId);
    scheduleTick(broadcastId, randomDelayMs(broadcast.delayMinSeconds, broadcast.delayMaxSeconds));
    return;
  }

  const templateResp = await fetch(`${TEMPLATE_URL}/internal/templates/${broadcast.templateId}`);
  const template = templateResp.ok ? ((await templateResp.json()) as { content: string; mediaUrl?: string }) : { content: '', mediaUrl: undefined };
  const contactResp = await fetch(`${CONTACT_URL}/internal/contacts/${nextTarget.contactId}`);
  const contact = contactResp.ok ? ((await contactResp.json()) as { phoneNumber: string }) : null;
  if (!contact) {
    await prisma.broadcastTarget.update({ where: { id: nextTarget.id }, data: { status: 'failed', failedReason: 'Contact not found' } });
    await checkAndUpdateBroadcastStatus(broadcastId);
    scheduleTick(broadcastId, randomDelayMs(broadcast.delayMinSeconds, broadcast.delayMaxSeconds));
    return;
  }

  const { messageId, dispatched } = await dispatchMessage({
    deviceId: device.id, contactId: nextTarget.contactId, broadcastId: broadcast.id,
    content: template.content, mediaUrl: template.mediaUrl, to: formatPhoneNumber(contact.phoneNumber),
  });

  await prisma.broadcastTarget.update({
    where: { id: nextTarget.id },
    data: dispatched ? { status: 'sent', messageId, sentAt: new Date() } : { status: 'failed', messageId, failedReason: 'Gateway engine offline' },
  });
  if (!dispatched) await checkAndUpdateBroadcastStatus(broadcastId);

  scheduleTick(broadcastId, randomDelayMs(broadcast.delayMinSeconds, broadcast.delayMaxSeconds));
}

export const resumeRunningBroadcasts = async () => {
  const running = await prisma.broadcast.findMany({ where: { status: 'running' } });
  for (const b of running) {
    console.log(`[campaign] Resuming in-flight broadcast ${b.id} after restart`);
    scheduleTick(b.id, 0);
  }
};
