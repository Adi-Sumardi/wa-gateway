import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

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
}

main()
  .catch((e) => {
    console.error('Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
