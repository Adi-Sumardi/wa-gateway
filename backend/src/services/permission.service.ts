import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

export const getGrantedKeys = async (role: Role): Promise<Set<string>> => {
  if (role === 'admin') {
    const all = await prisma.permission.findMany({ select: { key: true } });
    return new Set(all.map((p) => p.key));
  }

  const grants = await prisma.rolePermission.findMany({
    where: { role, granted: true },
    select: { permissionKey: true },
  });
  return new Set(grants.map((g) => g.permissionKey));
};

export const hasPermission = async (role: Role, key: string): Promise<boolean> => {
  if (role === 'admin') return true;
  const grant = await prisma.rolePermission.findUnique({
    where: { role_permissionKey: { role, permissionKey: key } },
  });
  return !!grant?.granted;
};
