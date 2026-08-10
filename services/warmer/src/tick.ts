// Ported from the monolith's warmer.service.ts, adapted to fetch device
// state from device-gateway-service (own DB now) and dispatch/notify over
// HTTP + the event bus instead of direct socket.io/Prisma calls.
import { PrismaClient } from '@prisma/client';
import { publish } from './_shared/events';

const prisma = new PrismaClient();
const DEVICE_GATEWAY_URL = process.env.DEVICE_GATEWAY_SERVICE_URL || 'http://device-gateway:6002';

const activeTimers = new Map<string, NodeJS.Timeout>();

const DEFAULT_PHRASES = [
  'Halo, apa kabar?', 'Lagi sibuk apa hari ini?', 'Udah makan siang belum?',
  'Btw cuaca hari ini enak ya', 'Eh iya, gimana kabar kerjaan?', 'Sore, istirahat dulu yuk',
  'Mantap, semangat terus!', 'Oke siap, noted ya', 'Wah keren juga', 'Hehe iya betul',
  'Nanti kita lanjut lagi ya', 'Makasih infonya',
];

const formatPhoneNumber = (num: string): string => {
  let cleaned = num.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.substring(1);
  if (!cleaned.endsWith('@c.us')) cleaned = cleaned + '@c.us';
  return cleaned;
};

const randomIntervalMs = (minMinutes: number, maxMinutes: number) => {
  const min = Math.min(minMinutes, maxMinutes);
  const max = Math.max(minMinutes, maxMinutes);
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 60_000;
};

const isInActiveHours = (hour: number, start: number, end: number) => {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
};

const scheduleTick = (sessionId: string, delayMs: number) => {
  const timer = setTimeout(() => runWarmerTick(sessionId), delayMs);
  activeTimers.set(sessionId, timer);
};

interface DeviceInfo { id: string; label: string; status: string; phoneNumber: string | null }

async function fetchDevices(deviceIds: string[]): Promise<DeviceInfo[]> {
  try {
    const resp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices?ids=${deviceIds.join(',')}`);
    if (!resp.ok) return [];
    return (await resp.json()) as DeviceInfo[];
  } catch (err) {
    console.error('[warmer] failed to fetch device state:', err);
    return [];
  }
}

async function dispatchViaDeviceGateway(params: { messageId: string; deviceId: string; to: string; body: string }): Promise<boolean> {
  try {
    const resp = await fetch(`${DEVICE_GATEWAY_URL}/internal/devices/${params.deviceId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: params.messageId, to: params.to, body: params.body }),
    });
    if (!resp.ok) return false;
    return ((await resp.json()) as any).dispatched === true;
  } catch (err) {
    console.error('[warmer] dispatch failed:', err);
    return false;
  }
}

async function runWarmerTick(sessionId: string) {
  const session = await prisma.warmerSession.findUnique({ where: { id: sessionId }, include: { devices: true } });
  if (!session || session.status !== 'active') {
    activeTimers.delete(sessionId);
    return;
  }

  const nextDelay = randomIntervalMs(session.minIntervalMinutes, session.maxIntervalMinutes);
  const hour = new Date().getHours();
  if (!isInActiveHours(hour, session.activeHourStart, session.activeHourEnd)) {
    scheduleTick(sessionId, 60_000);
    return;
  }

  const allDevices = await fetchDevices(session.devices.map((d) => d.deviceId));
  const connectedDevices = allDevices.filter((d) => d.status === 'connected' && d.phoneNumber);

  if (connectedDevices.length < 2) {
    scheduleTick(sessionId, nextDelay);
    return;
  }

  const lastLog = await prisma.warmerLog.findFirst({ where: { warmerSessionId: session.id, status: { not: 'failed' } }, orderBy: { createdAt: 'desc' } });

  let fromDevice = connectedDevices[0];
  let toDevice = connectedDevices[1];
  if (lastLog) {
    const lastReceiver = connectedDevices.find((d) => d.id === lastLog.toDeviceId);
    const lastSender = connectedDevices.find((d) => d.id === lastLog.fromDeviceId);
    if (lastReceiver && lastSender) {
      fromDevice = lastReceiver;
      toDevice = lastSender;
    }
  }

  const pool: string[] = Array.isArray(session.messagePool) && (session.messagePool as string[]).length > 0 ? (session.messagePool as string[]) : DEFAULT_PHRASES;
  const content = pool[Math.floor(Math.random() * pool.length)];

  const log = await prisma.warmerLog.create({ data: { warmerSessionId: session.id, fromDeviceId: fromDevice.id, toDeviceId: toDevice.id, content, status: 'queued' } });

  const dispatched = await dispatchViaDeviceGateway({ messageId: log.id, deviceId: fromDevice.id, to: formatPhoneNumber(toDevice.phoneNumber as string), body: content });

  if (!dispatched) {
    await prisma.warmerLog.update({ where: { id: log.id }, data: { status: 'failed', failedReason: 'Gateway engine offline' } });
  }

  publish('warmer.log.created', {
    userId: session.userId, id: log.id, warmerSessionId: session.id,
    fromDeviceId: fromDevice.id, fromDeviceLabel: fromDevice.label,
    toDeviceId: toDevice.id, toDeviceLabel: toDevice.label,
    content, status: dispatched ? 'queued' : 'failed', createdAt: log.createdAt,
  }).catch((err) => console.error('[warmer] publish failed:', err));

  scheduleTick(sessionId, dispatched ? nextDelay : Math.min(nextDelay, 3 * 60_000));
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
    console.log(`[warmer] Resuming active warmer session ${s.id} after restart`);
    scheduleTick(s.id, 15_000);
  }
};
