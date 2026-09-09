import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const expectedTables = [
  'addresses',
  'appeals',
  'audit_log',
  'auth_sessions',
  'compensations',
  'customer_credits',
  'customers',
  'fulfillment_exceptions',
  'integration_events',
  'inventory',
  'ledger_entries',
  'logistics_calendar',
  'order_items',
  'orders',
  'payments',
  'payouts',
  'pending_settlements',
  'product_attributes',
  'products',
  'roles',
  'settings',
  'shipments',
  'shipping_rates',
  'stock_declarations',
  'stock_holds',
  'stock_movements',
  'store_closures',
  'store_hours',
  'store_members',
  'store_orders',
  'stores',
  'strikes',
  'user_events',
  'user_roles',
  'users',
  'variants',
  'whatsapp_messages',
] as const;

const adapter = new PrismaPg({ connectionString: databaseUrl() });
const prisma = new PrismaClient({ adapter });

async function verifyAppendOnlyAuditLog(): Promise<void> {
  let mutationWasRejected = false;

  try {
    await prisma.$transaction(async (transaction) => {
      const entityId = randomUUID();

      await transaction.$executeRawUnsafe(
        `INSERT INTO audit_log (entity_type, entity_id, action, channel) VALUES ('verification', $1::uuid, 'created', 'SYSTEM')`,
        entityId,
      );
      await transaction.$executeRawUnsafe(
        `UPDATE audit_log SET action = 'modified' WHERE entity_id = $1::uuid`,
        entityId,
      );
    });
  } catch (error: unknown) {
    mutationWasRejected =
      error instanceof Error && error.message.includes('append-only');
  }

  assert(mutationWasRejected, 'audit_log accepted an UPDATE operation.');
}

async function main(): Promise<void> {
  const tableRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const existingTables = new Set(tableRows.map((row) => row.table_name));
  const missingTables = expectedTables.filter(
    (table) => !existingTables.has(table),
  );

  assert(
    missingTables.length === 0,
    `Missing tables: ${missingTables.join(', ')}`,
  );

  const foreignKeyRows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
  );
  const checkRows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`,
  );
  const triggerRows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%_append_only'`,
  );

  assert(
    (foreignKeyRows[0]?.count ?? 0) >= 38,
    'Expected foreign keys are missing.',
  );
  assert(
    (checkRows[0]?.count ?? 0) >= 20,
    'Expected check constraints are missing.',
  );
  assert(
    (triggerRows[0]?.count ?? 0) === 4,
    'Append-only triggers are missing.',
  );

  const roles = await prisma.role.count({ where: { system: true } });
  const settings = await prisma.setting.count();
  const administrator = await prisma.user.findUnique({
    where: { username: 'alexander' },
    include: { roles: { include: { role: true } } },
  });

  assert(roles === 6, `Expected 6 system roles, found ${roles}.`);
  assert(settings >= 6, `Expected at least 6 settings, found ${settings}.`);
  assert(administrator, 'Initial administrator alexander is missing.');
  assert(
    administrator.passwordHash !== '123',
    'Administrator password is not hashed.',
  );
  assert(
    administrator.roles.some(({ role }) => role.code === 'SUPER_ADMIN'),
    'Alexander does not have the SUPER_ADMIN role.',
  );
  assert(
    administrator.mustChangePassword || administrator.passwordChangedAt,
    'Administrator password lifecycle is not initialized.',
  );

  await verifyAppendOnlyAuditLog();

  console.log({
    tables: expectedTables.length,
    foreignKeys: foreignKeyRows[0]?.count,
    checkConstraints: checkRows[0]?.count,
    appendOnlyTriggers: triggerRows[0]?.count,
    systemRoles: roles,
    settings,
    administrator: administrator.username,
  });
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
