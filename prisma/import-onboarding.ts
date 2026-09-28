import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { importWebCatalog } from './catalog-web.js';
import { hash } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import {
  normalized,
  planOnboarding,
  readOnboardingWorkbook,
} from './onboarding-workbook.js';
import {
  legacyReferenceImage,
  referenceImageFor,
  refreshReferenceImages,
} from './onboarding-images.js';

const referenceImage = legacyReferenceImage;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: 'onboarding' },
      file: { type: 'string' },
      'env-file': { type: 'string' },
      target: { type: 'string', default: 'local' },
      'confirm-database': { type: 'string' },
      apply: { type: 'boolean', default: false },
      migrate: { type: 'boolean', default: false },
    },
  });
  if (!values.file)
    throw new Error(
      'Required: --file <onboarding.xlsx>. Default mode is read-only.',
    );
  if (!['local', 'production'].includes(values.target))
    throw new Error('Target must be local or production.');
  if (values.target === 'production' && !values['env-file'])
    throw new Error('Production requires a separate --env-file.');
  const environment = parse(
    await readFile(resolve(values['env-file'] ?? '.env')),
  );
  for (const key of [
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
  ]) {
    if (!environment[key])
      throw new Error(`Missing ${key} in the selected environment file.`);
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(
    environment.DB_HOST,
  );
  if (values.target === 'local' && !isLocal)
    throw new Error('Local target refuses remote database hosts.');
  if (values.target === 'production' && isLocal)
    throw new Error('Production target refuses localhost.');
  if (
    values.target === 'production' &&
    values.apply &&
    values['confirm-database'] !== environment.DB_NAME
  ) {
    throw new Error(
      'Production writes require --confirm-database matching DB_NAME.',
    );
  }
  if (values.migrate && !values.apply)
    throw new Error('--migrate requires --apply.');
  const sheets = await readOnboardingWorkbook(resolve(values.file));
  if (!['onboarding', 'web-catalog'].includes(values.source))
    throw new Error('Unknown import source.');
  if (values.source === 'web-catalog') {
    if (values.migrate)
      throw new Error(
        'Run db:deploy separately before the complementary import.',
      );
    await importWebCatalog(sheets, environment, values.apply, values.target);
    return;
  }
  const plan = planOnboarding(sheets);
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ version: 1, sheets, referenceImage }))
    .digest('hex');
  const summary = {
    target: values.target,
    mode: values.apply ? 'apply' : 'dry-run',
    sheets: sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.length,
    })),
    stores: plan.stores.length,
    products: plan.products.length,
    variants: plan.products.reduce(
      (total, product) => total + product.variants.length,
      0,
    ),
    declaredUnits: plan.products.reduce(
      (total, product) =>
        total +
        product.variants.reduce((sum, variant) => sum + variant.quantity, 0),
      0,
    ),
    eligibleAccounts: plan.stores.reduce(
      (total, store) => total + store.users.length,
      0,
    ),
    hours: plan.stores.reduce((total, store) => total + store.hours.length, 0),
    warnings: plan.warnings,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!values.apply) return;

  if (values.migrate) {
    const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const migration = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      {
        cwd: backendRoot,
        env: { ...process.env, ...environment },
        stdio: 'inherit',
      },
    );
    if (migration.error || migration.status !== 0)
      throw new Error('Migration failed; import was not started.');
  }
  const connectionString = `postgresql://${encodeURIComponent(environment.DB_USER)}:${encodeURIComponent(environment.DB_PASSWORD)}@${environment.DB_HOST}:${environment.DB_PORT}/${encodeURIComponent(environment.DB_NAME)}`;
  const ssl =
    values.target === 'production' ? { rejectUnauthorized: true } : undefined;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, ssl }),
  });
  try {
    const result = await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(728401928)`;
        const previous = await transaction.onboardingBatch.findUnique({
          where: { contentHash },
        });
        if (previous) {
          const referenceImagesUpdated = await refreshReferenceImages(
            transaction,
            plan.products.map((product) => product.id),
          );
          if (referenceImagesUpdated) {
            await transaction.auditLog.create({
              data: {
                entityType: 'onboarding_batch',
                entityId: previous.id,
                action: 'ONBOARDING_REFERENCE_IMAGES_UPDATED',
                channel: 'SYSTEM',
                reason: 'Distinct reference photos for local catalog review',
                metadata: { referenceImagesUpdated },
              },
            });
          }
          return {
            alreadyImported: true,
            batchId: previous.id,
            referenceImagesUpdated,
          };
        }
        const changes = {
          storesCreated: 0,
          storesUpdated: 0,
          productsCreated: 0,
          productsUpdated: 0,
          variantsCreated: 0,
          accountsCreated: 0,
          hoursCreated: 0,
        };
        const warnings = [...plan.warnings];
        const createdUsernames: string[] = [];
        const role = await transaction.role.upsert({
          where: { code: 'STORE_OPERATOR' },
          update: {},
          create: {
            code: 'STORE_OPERATOR',
            name: 'Store Operator',
            description: 'Manages the assigned store.',
            system: true,
          },
        });
        const allStores = await transaction.store.findMany({
          select: { id: true, displayName: true, whatsappNumber: true },
        });
        for (const store of plan.stores) {
          const collision = allStores.some(
            (existing) =>
              existing.id !== store.id &&
              (existing.whatsappNumber === store.whatsappNumber ||
                normalized(existing.displayName) === store.key),
          );
          if (collision)
            throw new Error(
              'An existing store matches onboarding but has another ID. Reconcile identities before importing.',
            );
          const existing = await transaction.store.findUnique({
            where: { id: store.id },
          });
          if (existing?.deletedAt)
            throw new Error(
              'An imported store was deleted; refusing to recreate it.',
            );
          const data = {
            displayName: store.displayName,
            legalName: store.legalName,
            gallery: store.gallery,
            standNumber: store.standNumber,
            whatsappNumber: store.whatsappNumber,
          };
          if (!existing) {
            await transaction.store.create({
              data: { id: store.id, ...data, status: 'APPLIED' },
            });
            changes.storesCreated++;
          } else if (
            ['APPLIED', 'UNDER_REVIEW', 'PENDING_DOCUMENTS'].includes(
              existing.status,
            )
          ) {
            await transaction.store.update({
              where: { id: store.id },
              data: {
                displayName: data.displayName,
                legalName: data.legalName ?? existing.legalName,
                gallery: data.gallery ?? existing.gallery,
                standNumber: data.standNumber ?? existing.standNumber,
                whatsappNumber: data.whatsappNumber,
                ...(data.whatsappNumber !== existing.whatsappNumber
                  ? { whatsappVerifiedAt: null }
                  : {}),
              },
            });
            changes.storesUpdated++;
          } else {
            warnings.push(
              `Store ${store.id}: operational state preserved; store updates require manual review.`,
            );
            continue;
          }
          for (const hour of store.hours) {
            const existingHours = await transaction.storeHour.findMany({
              where: { storeId: store.id, dayOfWeek: hour.dayOfWeek },
            });
            if (
              existingHours.some(
                (current) =>
                  current.opensAt.getTime() === hour.opensAt.getTime() &&
                  current.closesAt.getTime() === hour.closesAt.getTime(),
              )
            )
              continue;
            if (
              existingHours.some(
                (current) =>
                  hour.opensAt < current.closesAt &&
                  hour.closesAt > current.opensAt,
              )
            ) {
              warnings.push(
                `Store ${store.id}: changed hours retained in source; existing shift preserved.`,
              );
              continue;
            }
            await transaction.storeHour.create({
              data: { storeId: store.id, ...hour },
            });
            changes.hoursCreated++;
          }
          for (const user of store.users) {
            const existingUser = await transaction.user.findFirst({
              where: {
                OR: [
                  { id: user.id },
                  { username: user.username },
                  { email: user.email },
                  ...(user.phone ? [{ phone: user.phone }] : []),
                ],
              },
            });
            if (existingUser) {
              if (existingUser.id !== user.id)
                warnings.push(
                  `Store ${store.id}: account contact already exists; access must be granted manually.`,
                );
              continue;
            }
            const { isOwner, ...userData } = user;
            await transaction.user.create({
              data: {
                ...userData,
                passwordHash: await hash(
                  randomBytes(32).toString('base64url'),
                  12,
                ),
                mustChangePassword: true,
                roles: { create: { roleId: role.id } },
                storeMemberships: { create: { storeId: store.id, isOwner } },
              },
            });
            changes.accountsCreated++;
            createdUsernames.push(user.username);
          }
        }
        for (const product of plan.products) {
          const store = await transaction.store.findUniqueOrThrow({
            where: { id: product.storeId },
          });
          if (
            !['APPLIED', 'UNDER_REVIEW', 'PENDING_DOCUMENTS'].includes(
              store.status,
            )
          ) {
            warnings.push(
              `Product ${product.id}: store already operational; product updates require manual review.`,
            );
            continue;
          }
          const existing = await transaction.product.findUnique({
            where: { id: product.id },
          });
          if (
            existing &&
            (existing.storeId !== product.storeId || existing.deletedAt)
          )
            throw new Error('Product identity conflicts with existing data.');
          const collision = await transaction.product.findFirst({
            where: {
              storeId: product.storeId,
              name: product.name,
              id: { not: product.id },
            },
          });
          if (collision)
            throw new Error(
              'Product name already exists with a different ID. Reconcile before importing.',
            );
          if (
            existing &&
            !['DRAFT', 'UNDER_REVIEW', 'CHANGES_REQUESTED'].includes(
              existing.status,
            )
          ) {
            warnings.push(
              `Product ${product.id}: operational product preserved.`,
            );
            continue;
          }
          const { variants, stockUpdatedAt, ...data } = product;
          if (existing) {
            const oldAttributes =
              existing.attributes &&
              typeof existing.attributes === 'object' &&
              !Array.isArray(existing.attributes)
                ? existing.attributes
                : {};
            await transaction.product.update({
              where: { id: product.id },
              data: {
                ...data,
                description: data.description ?? existing.description,
                attributes: { ...oldAttributes, ...data.attributes },
              },
            });
            changes.productsUpdated++;
          } else {
            await transaction.product.create({
              data: { ...data, status: 'UNDER_REVIEW' },
            });
            changes.productsCreated++;
          }
          const image = await transaction.productAttribute.findFirst({
            where: { productId: product.id, code: 'image_url' },
          });
          if (!image) {
            await transaction.productAttribute.createMany({
              data: [
                {
                  productId: product.id,
                  code: 'image_url',
                  value: referenceImageFor(product.id),
                },
                {
                  productId: product.id,
                  code: 'image_kind',
                  value: 'reference_only_not_actual_product',
                },
              ],
            });
          }
          for (const variant of variants) {
            const current = await transaction.variant.findFirst({
              where: {
                OR: [
                  { id: variant.id },
                  { sku: variant.sku },
                  {
                    productId: product.id,
                    color: variant.color,
                    sizeNormalized: variant.sizeNormalized,
                  },
                ],
              },
              include: { inventory: true },
            });
            if (current) {
              if (current.id !== variant.id || current.productId !== product.id)
                throw new Error(
                  'Variant identity conflicts with existing data.',
                );
              if (current.inventory?.quantity !== variant.quantity)
                warnings.push(
                  `Variant ${variant.id}: existing stock preserved; new declaration retained in source.`,
                );
              continue;
            }
            const { quantity, ...variantData } = variant;
            await transaction.variant.create({
              data: {
                ...variantData,
                productId: product.id,
                inventory: { create: { quantity, stockUpdatedAt } },
                stockMovements: {
                  create: {
                    type: 'INITIAL',
                    quantity,
                    balanceAfter: quantity,
                    reason: 'Onboarding workbook initial stock declaration',
                  },
                },
              },
            });
            changes.variantsCreated++;
          }
        }
        const referenceImagesUpdated = await refreshReferenceImages(
          transaction,
          plan.products.map((product) => product.id),
        );
        const report = {
          ...summary,
          changes,
          warnings,
          createdUsernames,
          referenceImagesUpdated,
        };
        const batch = await transaction.onboardingBatch.create({
          data: {
            contentHash,
            source: 'GAMI Marketplace Onboarding',
            snapshot: sheets,
            report,
          },
        });
        await transaction.auditLog.create({
          data: {
            entityType: 'onboarding_batch',
            entityId: batch.id,
            action: 'ONBOARDING_IMPORTED',
            channel: 'SYSTEM',
            reason: 'Validated workbook import',
            metadata: { contentHash, ...changes },
          },
        });
        return { batchId: batch.id, ...report };
      },
      { timeout: 120000, isolationLevel: 'Serializable' },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await main();
} catch (error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    console.error(
      `Database import failed (${error.code}); transaction rolled back.`,
    );
  else
    console.error(
      error instanceof Error
        ? error.message.replace(
            /postgres(?:ql)?:\/\/[^\s]+/gi,
            '[redacted connection]',
          )
        : 'Onboarding import failed.',
    );
  process.exitCode = 1;
}
