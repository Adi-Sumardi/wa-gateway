import { PrismaClient } from '@prisma/client';
import { sendWhatsappMessage, checkAndUpdateBroadcastStatus } from '../socket';
import { formatPhoneNumber } from '../controllers/message.controller';

const prisma = new PrismaClient();

// One active dispatch timer per running broadcast, so pause/resume/restart
// never end up with two loops racing for the same broadcast.
const activeTimers = new Map<string, NodeJS.Timeout>();

const randomDelayMs = (minSeconds: number, maxSeconds: number) => {
  const min = Math.min(minSeconds, maxSeconds);
  const max = Math.max(minSeconds, maxSeconds);
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
};

const isInSleepWindow = (hour: number, sleepStart: number, sleepEnd: number) => {
  // Sleep window can wrap past midnight (e.g. 22 -> 7).
  if (sleepStart === sleepEnd) return false;
  if (sleepStart < sleepEnd) return hour >= sleepStart && hour < sleepEnd;
  return hour >= sleepStart || hour < sleepEnd;
};

export const createBroadcast = async (params: {
  userId: string;
  name: string;
  content?: string;
  mediaUrl?: string;
  deviceId: string;
  rotateDevices: boolean;
  phoneNumbers: string[];
  delayMinSeconds?: number;
  delayMaxSeconds?: number;
  sleepEnabled?: boolean;
  sleepStart?: number;
  sleepEnd?: number;
  scheduledAt?: Date;
  templateId?: string;
  isAdmin?: boolean;
}) => {
  const device = await prisma.device.findFirst({
    where: params.isAdmin ? { id: params.deviceId } : { id: params.deviceId, userId: params.userId },
  });
  if (!device) {
    throw new Error('Selected device not found or does not belong to you');
  }

  // Find-or-create a Contact per pasted number (same pattern as message.controller),
  // skipping anyone who's opted out and de-duping the pasted list.
  const uniqueNumbers = Array.from(new Set(params.phoneNumbers.map((n) => n.trim()).filter(Boolean)));
  const contactIds: string[] = [];
  for (const rawNumber of uniqueNumbers) {
    const formatted = formatPhoneNumber(rawNumber);
    const standardNumberOnly = formatted.replace('@c.us', '');

    let contact = await prisma.contact.findFirst({ where: { userId: params.userId, phoneNumber: standardNumberOnly } });
    if (!contact) {
      contact = await prisma.contact.create({
        data: { userId: params.userId, name: standardNumberOnly, phoneNumber: standardNumberOnly },
      });
    }
    if (contact.optedOut) continue;
    contactIds.push(contact.id);
  }

  if (contactIds.length === 0) {
    throw new Error('No valid, non-opted-out recipients in the provided list');
  }

  // Broadcast has no "content" column of its own - it's designed to reference
  // a Template instead. If the caller picked an existing saved template,
  // reuse it directly instead of creating a duplicate row; otherwise create
  // a throwaway Template to hold this broadcast's freeform body/media so
  // dispatch (including after a restart) always reads content the same way.
  let templateId: string;
  if (params.templateId) {
    const existing = await prisma.template.findFirst({
      where: params.isAdmin ? { id: params.templateId } : { id: params.templateId, userId: params.userId },
    });
    if (!existing) {
      throw new Error('Selected template not found or does not belong to you');
    }
    templateId = existing.id;
  } else {
    if (!params.content) {
      throw new Error('Either "content" or "templateId" is required');
    }
    const template = await prisma.template.create({
      data: {
        userId: params.userId,
        name: `[broadcast] ${params.name}`,
        content: params.content,
        mediaUrl: params.mediaUrl || null,
        mediaType: params.mediaUrl ? 'document' : 'none',
      },
    });
    templateId = template.id;
  }

  const broadcast = await prisma.broadcast.create({
    data: {
      name: params.name,
      templateId,
      deviceId: device.id,
      createdBy: params.userId,
      status: params.scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: params.scheduledAt || null,
      delayMinSeconds: params.delayMinSeconds ?? 5,
      delayMaxSeconds: params.delayMaxSeconds ?? 15,
      sleepEnabled: params.sleepEnabled ?? false,
      sleepStart: params.sleepStart ?? 22,
      sleepEnd: params.sleepEnd ?? 7,
      rotateDevices: params.rotateDevices,
      targets: {
        create: contactIds.map((contactId) => ({ contactId, status: 'queued' as const })),
      },
    },
    include: { targets: true },
  });

  return broadcast;
};

export const pauseBroadcast = async (broadcastId: string) => {
  const timer = activeTimers.get(broadcastId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(broadcastId);
  }
  await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'paused' } });
};

export const startBroadcast = async (broadcastId: string) => {
  if (activeTimers.has(broadcastId)) return; // already running

  // updateMany (not update) so the "don't restart a finished broadcast" guard
  // can be expressed in the WHERE clause atomically, without a separate
  // read-then-write - update() only accepts a unique WHERE (id), not this
  // compound filter.
  const result = await prisma.broadcast.updateMany({
    where: { id: broadcastId, status: { notIn: ['completed'] } },
    data: { status: 'running' },
  });
  if (result.count === 0) return;

  scheduleTick(broadcastId, 0);
};

const scheduleTick = (broadcastId: string, delayMs: number) => {
  const timer = setTimeout(() => dispatchNext(broadcastId), delayMs);
  activeTimers.set(broadcastId, timer);
};

async function dispatchNext(broadcastId: string) {
  const broadcast = await prisma.broadcast.findUnique({
    where: { id: broadcastId },
    include: { template: true },
  });

  if (!broadcast || broadcast.status !== 'running') {
    activeTimers.delete(broadcastId);
    return;
  }

  if (broadcast.sleepEnabled) {
    const hour = new Date().getHours();
    if (isInSleepWindow(hour, broadcast.sleepStart, broadcast.sleepEnd)) {
      // Check again in a minute rather than computing an exact wake time -
      // simple and avoids DST/timezone edge cases.
      scheduleTick(broadcastId, 60_000);
      return;
    }
  }

  const nextTarget = await prisma.broadcastTarget.findFirst({
    where: { broadcastId, status: 'queued' },
    include: { contact: true },
    orderBy: { id: 'asc' },
  });

  if (!nextTarget) {
    // Nothing left to dispatch; the existing message-status-driven
    // checkAndUpdateBroadcastStatus() call will flip the broadcast to
    // completed/failed once the last outstanding ack comes back.
    activeTimers.delete(broadcastId);
    return;
  }

  const device = broadcast.rotateDevices
    ? await pickRotatingDevice(broadcast.createdBy)
    : await prisma.device.findUnique({ where: { id: broadcast.deviceId } });

  if (!device || device.status !== 'connected') {
    await prisma.broadcastTarget.update({
      where: { id: nextTarget.id },
      data: { status: 'failed', failedReason: 'No connected device available at send time' },
    });
    // This target never reaches the gateway, so it never produces a
    // 'message-status' ack - that's the only other place completion gets
    // checked, so without this call a broadcast that ends in dispatch-time
    // failures would stay stuck in 'running' forever.
    await checkAndUpdateBroadcastStatus(broadcastId);
    scheduleTick(broadcastId, randomDelayMs(broadcast.delayMinSeconds, broadcast.delayMaxSeconds));
    return;
  }

  const content = broadcast.template?.content || '';
  const mediaUrl = broadcast.template?.mediaUrl || undefined;

  const msg = await prisma.message.create({
    data: {
      deviceId: device.id,
      contactId: nextTarget.contactId,
      broadcastId: broadcast.id,
      direction: 'outbound',
      content,
      mediaUrl: mediaUrl || null,
      status: 'queued',
    },
  });

  await prisma.broadcastTarget.update({
    where: { id: nextTarget.id },
    data: { status: 'sent', messageId: msg.id, sentAt: new Date() },
  });

  const dispatched = sendWhatsappMessage({
    messageId: msg.id,
    deviceId: device.id,
    to: formatPhoneNumber(nextTarget.contact.phoneNumber),
    body: content,
    mediaUrl,
  });

  if (!dispatched) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: 'failed', failedReason: 'Gateway engine is not connected to API server' },
    });
    await prisma.broadcastTarget.update({
      where: { id: nextTarget.id },
      data: { status: 'failed', failedReason: 'Gateway engine offline' },
    });
    // Same reasoning as the no-connected-device branch above: this message
    // never reached the gateway, so no ack will ever drive completion.
    await checkAndUpdateBroadcastStatus(broadcastId);
  }

  scheduleTick(broadcastId, randomDelayMs(broadcast.delayMinSeconds, broadcast.delayMaxSeconds));
}

async function pickRotatingDevice(userId: string) {
  const connectedDevices = await prisma.device.findMany({
    where: { status: 'connected', userId },
    orderBy: { lastConnectedAt: 'asc' },
  });
  if (connectedDevices.length === 0) return null;
  const device = connectedDevices[0];
  await prisma.device.update({ where: { id: device.id }, data: { lastConnectedAt: new Date() } });
  return device;
}

export const resumeRunningBroadcasts = async () => {
  const running = await prisma.broadcast.findMany({ where: { status: 'running' } });
  for (const b of running) {
    console.log(`[Broadcast] Resuming in-flight broadcast ${b.id} after restart`);
    scheduleTick(b.id, 0);
  }
};
