import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  seedDeploymentCatalog,
  storeContacts,
  type DeploymentCatalog,
} from './deployment-catalog.js';

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

export async function seedBootstrap(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  const username = required('INITIAL_ADMIN_USERNAME').trim().toLowerCase();
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

  const existing = await transaction.user.findUnique({ where: { username } });
  if (!existing) {
    const user = await transaction.user.create({
      data: {
        username,
        displayName: required('INITIAL_ADMIN_DISPLAY_NAME').trim(),
        passwordHash: await hash(required('INITIAL_ADMIN_PASSWORD'), 12),
        mustChangePassword: true,
        status: 'ACTIVE',
      },
    });
    await transaction.userRole.create({
      data: {
        userId: user.id,
        roleId: superAdminRole.id,
        grantedById: user.id,
      },
    });
  }

  await Promise.all(
    defaultSettings.map(([key, value, description]) =>
      transaction.setting.upsert({
        where: { key },
        update: {},
        create: { key, value, description },
      }),
    ),
  );
}

async function main(): Promise<void> {
  const catalog = JSON.parse(
    await readFile(new URL('./data/catalog-v2.json', import.meta.url), 'utf8'),
  ) as DeploymentCatalog;
  const contacts = storeContacts(
    process.env.CATALOG_STORE_CONTACTS_JSON,
    catalog,
  );
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl() }),
  });
  try {
    const result = await prisma.$transaction(
      async (transaction) => {
        const report = await seedDeploymentCatalog(
          transaction,
          catalog,
          contacts,
        );
        await seedBootstrap(transaction);
        return report;
      },
      { isolationLevel: 'Serializable', timeout: 120000 },
    );
    console.log(JSON.stringify({ bootstrap: 'completed', catalog: result }));
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'Error')
      console.error(error.message);
    else
      console.error(
        'Database seed failed; transaction rolled back. Check database access, schema and catalog identity constraints.',
      );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch {
    console.error(
      'Seed configuration failed. Check the catalog file and required environment variables.',
    );
    process.exitCode = 1;
  }
}
