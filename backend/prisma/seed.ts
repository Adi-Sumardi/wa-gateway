import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const PERMISSIONS: { key: string; label: string; category: string }[] = [
  { key: 'devices.view', label: 'View devices', category: 'Devices' },
  { key: 'devices.manage', label: 'Manage devices (create/delete/reconnect)', category: 'Devices' },
  { key: 'messages.view', label: 'View messages', category: 'Messages' },
  { key: 'messages.send', label: 'Send messages', category: 'Messages' },
  { key: 'broadcast.view', label: 'View broadcasts', category: 'Broadcast' },
  { key: 'broadcast.manage', label: 'Manage broadcasts', category: 'Broadcast' },
  { key: 'warmer.view', label: 'View WA Warmer sessions', category: 'WA Warmer' },
  { key: 'warmer.manage', label: 'Manage WA Warmer sessions', category: 'WA Warmer' },
  { key: 'webhooks.manage', label: 'Manage webhooks', category: 'Settings' },
  { key: 'apikeys.manage', label: 'Manage API keys', category: 'Settings' },
  { key: 'links.manage', label: 'Manage link shortener', category: 'Settings' },
  { key: 'settings.view', label: 'View API & Settings page', category: 'Settings' },
  { key: 'users.manage', label: 'Manage users, roles & permissions', category: 'Users' },
  { key: 'contacts.view', label: 'View contacts & groups', category: 'Contacts' },
  { key: 'contacts.manage', label: 'Manage contacts & groups', category: 'Contacts' },
  { key: 'templates.view', label: 'View message templates', category: 'Templates' },
  { key: 'templates.manage', label: 'Manage message templates', category: 'Templates' },
  { key: 'audit.view', label: 'View audit log', category: 'Users' },
  { key: 'credits.manage', label: 'Manage AI credits / top-ups', category: 'Users' },
];

// operator/viewer defaults; admin is always fully granted regardless of this table
const DEFAULT_GRANTS: Record<Exclude<Role, 'admin'>, string[]> = {
  operator: [
    'devices.view', 'devices.manage',
    'messages.view', 'messages.send',
    'broadcast.view', 'broadcast.manage',
    'warmer.view', 'warmer.manage',
    'links.manage',
    'settings.view',
    'contacts.view', 'contacts.manage',
    'templates.view', 'templates.manage',
  ],
  viewer: [
    'devices.view',
    'messages.view',
    'broadcast.view',
    'warmer.view',
    'settings.view',
    'contacts.view',
    'templates.view',
  ],
};

async function seedPermissions() {
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: { label: perm.label, category: perm.category },
      create: perm,
    });
  }

  for (const [role, keys] of Object.entries(DEFAULT_GRANTS) as [Exclude<Role, 'admin'>, string[]][]) {
    for (const perm of PERMISSIONS) {
      const exists = await prisma.rolePermission.findUnique({
        where: { role_permissionKey: { role: role as Role, permissionKey: perm.key } },
      });
      // Only seed if this (role, permission) pair has never been set before,
      // so re-running the seed doesn't clobber an admin's later customization.
      if (!exists) {
        await prisma.rolePermission.create({
          data: { role: role as Role, permissionKey: perm.key, granted: keys.includes(perm.key) },
        });
      }
    }
  }
  console.log('Seeded permissions and default role grants.');
}

const DEFAULT_PACKAGES: { name: string; productType: 'ai_credit' | 'broadcast_quota' | 'warmer_slot'; quotaAmount: number; priceRp: number }[] = [
  { name: 'Paket Hemat', productType: 'ai_credit', quotaAmount: 100, priceRp: 10000 },
  { name: 'Paket Reguler', productType: 'ai_credit', quotaAmount: 500, priceRp: 50000 },
  { name: 'Paket Hemat Besar', productType: 'ai_credit', quotaAmount: 1000, priceRp: 95000 },
  { name: 'Kuota Broadcast 1.000 Pesan', productType: 'broadcast_quota', quotaAmount: 1000, priceRp: 50000 },
  { name: 'Kuota Broadcast 5.000 Pesan', productType: 'broadcast_quota', quotaAmount: 5000, priceRp: 200000 },
  { name: 'Slot Warmer Tambahan', productType: 'warmer_slot', quotaAmount: 1, priceRp: 30000 },
];

async function seedCreditPackages() {
  for (const pkg of DEFAULT_PACKAGES) {
    const exists = await prisma.creditPackage.findFirst({ where: { name: pkg.name } });
    if (!exists) {
      await prisma.creditPackage.create({ data: pkg });
    }
  }
  console.log('Seeded default credit packages (AI credit, broadcast quota, warmer slot).');
}

async function main() {
  // Check if admin user exists
  const existingAdmin = await prisma.user.findUnique({
    where: { email: 'admin@sendago.com' }
  });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash('admin12345', 10);
    const admin = await prisma.user.create({
      data: {
        name: 'Administrator',
        email: 'admin@sendago.com',
        passwordHash,
        role: 'admin',
        isActive: true,
      }
    });
    console.log('Seeded default admin user:', admin.email);
  } else {
    console.log('Admin user already exists, skipping seed.');
  }

  await seedPermissions();
  await seedCreditPackages();
}

main()
  .catch((e) => {
    console.error('Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
