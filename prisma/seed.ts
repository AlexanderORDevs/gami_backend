import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.js';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function databaseUrl(): string {
  const user = encodeURIComponent(required('DB_USER'));
  const password = encodeURIComponent(required('DB_PASSWORD'));
  const host = required('DB_HOST');
  const port = required('DB_PORT');
  const database = encodeURIComponent(required('DB_NAME'));

  return `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`;
}

const adapter = new PrismaPg({ connectionString: databaseUrl() });
const prisma = new PrismaClient({ adapter });

const systemRoles = [
  {
    code: 'SUPER_ADMIN',
    name: 'Super Administrator',
    description: 'Full access to platform administration.',
  },
  {
    code: 'CATALOG_MANAGER',
    name: 'Catalog Manager',
    description: 'Reviews stores, products, variants, and catalog content.',
  },
  {
    code: 'OPERATIONS_MANAGER',
    name: 'Operations Manager',
    description: 'Manages confirmations, exceptions, and order operations.',
  },
  {
    code: 'WAREHOUSE_OPERATOR',
    name: 'Warehouse Operator',
    description:
      'Manages pickup, quality control, consolidation, and dispatch.',
  },
  {
    code: 'FINANCE_MANAGER',
    name: 'Finance Manager',
    description:
      'Manages settlements, payouts, credits, and financial records.',
  },
  {
    code: 'STORE_OPERATOR',
    name: 'Store Operator',
    description:
      'Manages an assigned store, catalog, stock, and confirmations.',
  },
] as const;

const defaultSettings = [
  [
    'stock_hold_ttl_minutes',
    15,
    'Minutes before an unpaid stock hold expires.',
  ],
  [
    'confirmation_sla_minutes',
    60,
    'Operational minutes allowed for store confirmation.',
  ],
  [
    'whatsapp_delivery_tolerance_minutes',
    3,
    'Maximum message delivery tolerance before escalation.',
  ],
  ['active_strike_limit', 5, 'Active strikes that trigger store suspension.'],
  ['strike_expiration_days', 90, 'Days before an active strike expires.'],
  ['appeal_window_days', 7, 'Days allowed to submit a strike appeal.'],
] as const;

async function main(): Promise<void> {
  const username = required('INITIAL_ADMIN_USERNAME').trim().toLowerCase();
  const displayName = required('INITIAL_ADMIN_DISPLAY_NAME').trim();
  const passwordHash = await hash(required('INITIAL_ADMIN_PASSWORD'), 12);

  await prisma.$transaction(async (transaction) => {
    const roles = await Promise.all(
      systemRoles.map((role) =>
        transaction.role.upsert({
          where: { code: role.code },
          update: {
            name: role.name,
            description: role.description,
            system: true,
          },
          create: { ...role, system: true },
        }),
      ),
    );
    const superAdminRole = roles.find((role) => role.code === 'SUPER_ADMIN');

    if (!superAdminRole) {
      throw new Error('SUPER_ADMIN role was not created.');
    }

    const user = await transaction.user.upsert({
      where: { username },
      update: { displayName, status: 'ACTIVE' },
      create: {
        username,
        displayName,
        passwordHash,
        mustChangePassword: true,
        status: 'ACTIVE',
      },
    });

    if (!user.passwordChangedAt && !user.mustChangePassword) {
      await transaction.user.update({
        where: { id: user.id },
        data: { mustChangePassword: true },
      });
    }

    await transaction.userRole.upsert({
      where: {
        userId_roleId: {
          userId: user.id,
          roleId: superAdminRole.id,
        },
      },
      update: {},
      create: {
        userId: user.id,
        roleId: superAdminRole.id,
        grantedById: user.id,
      },
    });

    await Promise.all(
      defaultSettings.map(([key, value, description]) =>
        transaction.setting.upsert({
          where: { key },
          update: { value, description },
          create: { key, value, description },
        }),
      ),
    );
  });

  console.log(`Seeded initial administrator: ${username}`);
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
