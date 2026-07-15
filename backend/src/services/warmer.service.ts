import { PrismaClient } from '@prisma/client';
import { sendWhatsappMessage, emitToDashboard } from '../socket';
import { formatPhoneNumber } from '../controllers/message.controller';

const prisma = new PrismaClient();

const activeTimers = new Map<string, NodeJS.Timeout>();

const DEFAULT_PHRASES = [
  'Halo, apa kabar?',
  'Lagi sibuk apa hari ini?',
  'Udah makan siang belum?',
  'Btw cuaca hari ini enak ya',
  'Eh iya, gimana kabar kerjaan?',
  'Sore, istirahat dulu yuk',
  'Mantap, semangat terus!',
  'Oke siap, noted ya',
  'Wah keren juga',
  'Hehe iya betul',
  'Nanti kita lanjut lagi ya',
  'Makasih infonya',
];

const randomIntervalMs = (minMinutes: number, maxMinutes: number) => {
  const min = Math.min(minMinutes, maxMinutes);
  const max = Math.max(minMinutes, maxMinutes);
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 60_000;
};

const isInActiveHours = (hour: number, start: number, end: number) => {
  if (start === end) return true; // 24h active
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // wraps past midnight
};

const scheduleTick = (sessionId: string, delayMs: number) => {
  const timer = setTimeout(() => runWarmerTick(sessionId), delayMs);
  activeTimers.set(sessionId, timer);
};

async function runWarmerTick(sessionId: string) {
  const session = await prisma.warmerSession.findUnique({
    where: { id: sessionId },
    include: { devices: { include: { device: true } } },
  });

  if (!session || session.status !== 'active') {
    activeTimers.delete(sessionId);
    return;
  }

  const nextDelay = randomIntervalMs(session.minIntervalMinutes, session.maxIntervalMinutes);

  const hour = new Date().getHours();
  if (!isInActiveHours(hour, session.activeHourStart, session.activeHourEnd)) {
    scheduleTick(sessionId, 60_000); // re-check in a minute rather than compute exact wake time
    return;
  }

  const connectedDevices = session.devices
    .map((d) => d.device)
    .filter((d) => d.status === 'connected' && d.phoneNumber);

  if (connectedDevices.length < 2) {
    // Not enough connected devices right now; try again on the normal cadence.
    scheduleTick(sessionId, nextDelay);
    return;
  }

  const fromIdx = Math.floor(Math.random() * connectedDevices.length);
  let toIdx = Math.floor(Math.random() * connectedDevices.length);
  while (toIdx === fromIdx) {
    toIdx = Math.floor(Math.random() * connectedDevices.length);
  }
  const fromDevice = connectedDevices[fromIdx];
  const toDevice = connectedDevices[toIdx];

  const pool: string[] = Array.isArray(session.messagePool) && (session.messagePool as string[]).length > 0
    ? (session.messagePool as string[])
    : DEFAULT_PHRASES;
  const content = pool[Math.floor(Math.random() * pool.length)];

  const log = await prisma.warmerLog.create({
    data: {
      warmerSessionId: session.id,
      fromDeviceId: fromDevice.id,
      toDeviceId: toDevice.id,
      content,
      status: 'queued',
    },
  });

  const dispatched = sendWhatsappMessage({
    messageId: log.id,
    deviceId: fromDevice.id,
    to: formatPhoneNumber(toDevice.phoneNumber as string),
    body: content,
  });

  if (!dispatched) {
    await prisma.warmerLog.update({
      where: { id: log.id },
      data: { status: 'failed', failedReason: 'Gateway engine offline' },
    });
  }

  // Broadcast the exchange to dashboards, mirroring the existing 'new-message'
  // live-update pattern in socket.ts.
  emitToDashboard('warmer-log', {
    id: log.id,
    warmerSessionId: session.id,
    fromDeviceId: fromDevice.id,
    fromDeviceLabel: fromDevice.label,
    toDeviceId: toDevice.id,
    toDeviceLabel: toDevice.label,
    content,
    status: dispatched ? 'queued' : 'failed',
    createdAt: log.createdAt,
  });

  scheduleTick(sessionId, nextDelay);
}

export const startWarmer = async (sessionId: string) => {
  if (activeTimers.has(sessionId)) return;
  await prisma.warmerSession.update({ where: { id: sessionId }, data: { status: 'active' } });
  scheduleTick(sessionId, 0);
};

export const pauseWarmer = async (sessionId: string) => {
  const timer = activeTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(sessionId);
  }
  await prisma.warmerSession.update({ where: { id: sessionId }, data: { status: 'paused' } });
};

export const resumeActiveWarmers = async () => {
  const active = await prisma.warmerSession.findMany({ where: { status: 'active' } });
  for (const s of active) {
    console.log(`[Warmer] Resuming active warmer session ${s.id} after restart`);
    scheduleTick(s.id, 0);
  }
};
