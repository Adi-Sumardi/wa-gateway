import { PrismaClient } from '@prisma/client';
import { resumeRunningBroadcasts, startBroadcast } from './broadcast.service';
import { resumeActiveWarmers } from './warmer.service';

const prisma = new PrismaClient();

const SCHEDULED_BROADCAST_POLL_MS = 30_000;

const checkScheduledBroadcasts = async () => {
  const due = await prisma.broadcast.findMany({
    where: { status: 'scheduled', scheduledAt: { lte: new Date() } },
  });
  for (const b of due) {
    console.log(`[Scheduler] Auto-starting scheduled broadcast ${b.id} (due at ${b.scheduledAt})`);
    await startBroadcast(b.id);
  }
};

// Called once on backend startup: re-arms any broadcast/warmer loops left
// running before a restart/deploy, and starts polling for scheduled
// broadcasts whose time has come. No job-queue dependency needed at this
// scale - a simple interval is enough.
export const initScheduler = async () => {
  await resumeRunningBroadcasts();
  await resumeActiveWarmers();
  setInterval(checkScheduledBroadcasts, SCHEDULED_BROADCAST_POLL_MS);
};
