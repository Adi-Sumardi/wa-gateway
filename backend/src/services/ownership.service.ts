import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// One-time (idempotent) backfill: Contact/Webhook/LinkTracker used to be
// fully global with no owner. Now that they're scoped per-user, assign any
// pre-existing unowned row to the oldest active admin so nothing silently
// disappears after this deploy. No-ops once nothing is left unowned.
export const backfillLegacyOwnership = async () => {
  const admin = await prisma.user.findFirst({
    where: { role: 'admin', isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!admin) {
    console.warn('[Ownership] No active admin found; skipping legacy data backfill.');
    return;
  }

  const [contacts, webhooks, links, templates, contactGroups] = await Promise.all([
    prisma.contact.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
    prisma.webhook.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
    prisma.linkTracker.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
    prisma.template.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
    prisma.contactGroup.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
  ]);

  if (contacts.count || webhooks.count || links.count || templates.count || contactGroups.count) {
    console.log(
      `[Ownership] Backfilled legacy data to admin ${admin.email}: ${contacts.count} contacts, ${webhooks.count} webhooks, ${links.count} links, ${templates.count} templates, ${contactGroups.count} contact groups.`
    );
  }
};
