import { PrismaClient } from '@prisma/client';
import { resumeRunningBroadcasts, startBroadcast } from './broadcast.service';
import { resumeActiveWarmers } from './warmer.service';

const prisma = new PrismaClient();

const SCHEDULED_BROADCAST_POLL_MS = 30_000;
const BROADCAST_QUOTA_RESET_CHECK_MS = 60 * 60 * 1000; // hourly

// Monthly broadcast quota "resets" by comparing the stored reset stamp's
// month/year against now - only users who've actually used any quota this
// period are touched, so this stays cheap even with many members.
const resetMonthlyBroadcastQuotas = async () => {
  const now = new Date();
  const users = await prisma.user.findMany({
    where: { broadcastSentThisMonth: { gt: 0 } },
    select: { id: true, broadcastQuotaResetAt: true },
  });
  for (const u of users) {
    const last = u.broadcastQuotaResetAt;
    const needsReset = !last || last.getUTCMonth() !== now.getUTCMonth() || last.getUTCFullYear() !== now.getUTCFullYear();
    if (needsReset) {
      await prisma.user.update({
        where: { id: u.id },
        data: { broadcastSentThisMonth: 0, broadcastQuotaResetAt: now },
      });
      console.log(`[Scheduler] Reset monthly broadcast quota usage for user ${u.id}`);
    }
  }
};

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
  await resetMonthlyBroadcastQuotas();
  setInterval(checkScheduledBroadcasts, SCHEDULED_BROADCAST_POLL_MS);
  setInterval(resetMonthlyBroadcastQuotas, BROADCAST_QUOTA_RESET_CHECK_MS);
};
