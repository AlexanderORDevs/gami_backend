import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '../src/generated/prisma/client.js';

export type DeploymentCatalog = {
  version: 1 | 2;
  stores: {
    id: string;
    displayName: string;
    legalName?: string | null;
    gallery: string | null;
    standNumber: string | null;
    hours: { dayOfWeek: number; opensAt: string; closesAt: string }[];
  }[];
  products: {
    id: string;
    storeId: string;
    name: string;
    description: string | null;
    category: string;
    garmentType: string;
    unitPriceInCents: number;
    wholesalePriceInCents: number | null;
    wholesaleMinimum: number | null;
    attributes: Prisma.InputJsonObject;
    status: 'DRAFT' | 'UNDER_REVIEW';
    images: { code: string; value: string; position: number }[];
    variants: {
      id: string;
      sku: string;
      sizeNormalized: string;
      sizeLabel: string;
      color: string;
      active: boolean;
      inventory: { quantity: number; stockUpdatedAt: string } | null;
    }[];
  }[];
};

export function publicAttributes(
  value: Prisma.JsonValue,
): Prisma.InputJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, Prisma.InputJsonValue> = {};
  for (const key of [
    'material',
    'fit',
    'details',
    'care',
    'occasion',
    'other_occasions',
    'stock_date_source',
    'catalog_web_id',
    'catalog_web_type',
  ]) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  if (Array.isArray(value.declared_sizes)) {
    result.declared_sizes = value.declared_sizes.filter(
      (size): size is string => typeof size === 'string',
    );
  }
  if (Array.isArray(value.declared_colors)) {
    result.declared_colors = value.declared_colors.flatMap((color) => {
      if (
        !color ||
        typeof color !== 'object' ||
        Array.isArray(color) ||
        typeof color.name !== 'string'
      )
        return [];
      return [
        {
          name: color.name,
          hex:
            typeof color.hex === 'string' && /^#[\da-f]{6}$/i.test(color.hex)
              ? color.hex
              : null,
        },
      ];
    });
  }
  return result;
}

export function storeContacts(
  raw: string | undefined,
  catalog: DeploymentCatalog,
): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CATALOG_STORE_CONTACTS_JSON must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('CATALOG_STORE_CONTACTS_JSON must be a JSON object.');
  const result: Record<string, string> = {};
  const numbers = new Set<string>();
  for (const [id, number] of Object.entries(parsed)) {
    if (
      !catalog.stores.some((store) => store.id === id) ||
      typeof number !== 'string' ||
      !/^\+?\d{7,15}$/.test(number)
    ) {
      throw new Error(
        'Invalid store identity or phone format in CATALOG_STORE_CONTACTS_JSON.',
      );
    }
    const normalizedNumber = number.replace(/^\+/, '');
    if (numbers.has(normalizedNumber))
      throw new Error(
        'Duplicate store contacts in CATALOG_STORE_CONTACTS_JSON.',
      );
    numbers.add(normalizedNumber);
    result[id] = number;
  }
  return result;
}

async function seedCatalogStore(
  transaction: Prisma.TransactionClient,
  source: DeploymentCatalog['stores'][number],
  contacts: Record<string, string>,
): Promise<boolean> {
  const existing = await transaction.store.findUnique({
    where: { id: source.id },
  });
  if (existing) {
    if (existing.deletedAt)
      throw new Error(
        `Catalog store ${source.id} is deleted; reconcile manually.`,
      );
    return false;
  }
  const whatsappNumber = contacts[source.id];
  if (!whatsappNumber)
    throw new Error(
      `Set CATALOG_STORE_CONTACTS_JSON in Render before deploying. Missing store: ${source.displayName} (${source.id}).`,
    );
  const collision = await transaction.store.findFirst({
    where: {
      OR: [
        {
          whatsappNumber: {
            in: [
              whatsappNumber,
              whatsappNumber.replace(/^\+/, ''),
              `+${whatsappNumber.replace(/^\+/, '')}`,
            ],
          },
        },
        { displayName: { equals: source.displayName, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (collision)
    throw new Error(
      `Catalog store identity conflict for ${source.displayName}; reconcile manually.`,
    );
  const { hours, ...store } = source;
  await transaction.store.create({
    data: {
      ...store,
      whatsappNumber,
      status: 'APPLIED',
      hours: {
        create: hours.map((hour) => ({
          ...hour,
          opensAt: new Date(hour.opensAt),
          closesAt: new Date(hour.closesAt),
        })),
      },
    },
  });
  return true;
}

async function seedCatalogProduct(
  transaction: Prisma.TransactionClient,
  source: DeploymentCatalog['products'][number],
): Promise<boolean> {
  const existing = await transaction.product.findUnique({
    where: { id: source.id },
  });
  if (existing) {
    if (existing.storeId !== source.storeId || existing.deletedAt)
      throw new Error(`Catalog product identity conflict: ${source.id}.`);
    return false;
  }
  const collision = await transaction.product.findFirst({
    where: {
      storeId: source.storeId,
      name: { equals: source.name, mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (collision)
    throw new Error(
      `Catalog product name already exists under another identity: ${source.id}.`,
    );
  const { images, variants, ...product } = source;
  await transaction.product.create({
    data: {
      ...product,
      status: source.status === 'DRAFT' ? 'DRAFT' : 'UNDER_REVIEW',
      productAttributes: { create: images },
      variants: {
        create: variants.map(({ inventory, ...variant }) => ({
          ...variant,
          ...(inventory
            ? {
                inventory: {
                  create: {
                    quantity: inventory.quantity,
                    stockUpdatedAt: new Date(inventory.stockUpdatedAt),
                  },
                },
                stockMovements: {
                  create: {
                    type: 'INITIAL',
                    quantity: inventory.quantity,
                    balanceAfter: inventory.quantity,
                    reason: 'Initial catalog deployment',
                    createdAt: new Date(inventory.stockUpdatedAt),
                  },
                },
              }
            : {}),
        })),
      },
    },
  });
  return true;
}

async function completeDeploymentDetails(
  transaction: Prisma.TransactionClient,
  catalog: DeploymentCatalog,
): Promise<number> {
  if (catalog.version !== 2) return 0;
  let updated = 0;
  for (const store of catalog.stores) {
    if (!store.legalName) continue;
    const result = await transaction.store.updateMany({
      where: { id: store.id, legalName: null, deletedAt: null },
      data: { legalName: store.legalName },
    });
    updated += result.count;
  }
  for (const product of catalog.products) {
    const current = await transaction.product.findUniqueOrThrow({
      where: { id: product.id },
      select: { attributes: true, updatedAt: true },
    });
    const attributes = current.attributes;
    if (
      attributes !== null &&
      (typeof attributes !== 'object' || Array.isArray(attributes))
    )
      continue;
    const stored = attributes ?? {};
    const additions = Object.fromEntries(
      ['stock_date_source', 'catalog_web_id', 'catalog_web_type']
        .filter(
          (key) =>
            !(key in stored) && typeof product.attributes[key] === 'string',
        )
        .map((key) => [key, product.attributes[key]]),
    );
    if (!Object.keys(additions).length) continue;
    const result = await transaction.product.updateMany({
      where: {
        id: product.id,
        storeId: product.storeId,
        deletedAt: null,
        updatedAt: current.updatedAt,
      },
      data: {
        attributes: { ...stored, ...additions } as Prisma.InputJsonObject,
      },
    });
    updated += result.count;
  }
  return updated;
}

export async function seedDeploymentCatalog(
  transaction: Prisma.TransactionClient,
  catalog: DeploymentCatalog,
  contacts: Record<string, string>,
) {
  if (catalog.version !== 1 && catalog.version !== 2)
    throw new Error('Unsupported deployment catalog version.');
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(728401928)`;
  const report = {
    storesCreated: 0,
    productsCreated: 0,
    productsPreserved: 0,
    variantsCreated: 0,
  };
  for (const source of catalog.stores) {
    if (await seedCatalogStore(transaction, source, contacts))
      report.storesCreated++;
  }
  for (const source of catalog.products) {
    if (!catalog.stores.some((store) => store.id === source.storeId))
      throw new Error(`Unknown catalog store for product ${source.id}.`);
    if (await seedCatalogProduct(transaction, source)) {
      report.productsCreated++;
      report.variantsCreated += source.variants.length;
    } else {
      report.productsPreserved++;
    }
  }
  const detailsEnriched = await completeDeploymentDetails(transaction, catalog);
  if (detailsEnriched) Object.assign(report, { detailsEnriched });
  if (report.storesCreated || report.productsCreated || detailsEnriched) {
    await transaction.auditLog.create({
      data: {
        entityType: 'catalog_deployment',
        entityId: randomUUID(),
        action: 'CATALOG_DEPLOYMENT_IMPORTED',
        channel: 'SYSTEM',
        reason:
          'Versioned catalog bootstrap; existing values preserved, missing v2 details completed',
        metadata: {
          ...report,
          contentHash: createHash('sha256')
            .update(JSON.stringify(catalog))
            .digest('hex'),
        },
      },
    });
  }
  return report;
}

const reviewedCatalogHash =
  '1fc2d2c60a1845fab5f96d5c77118801c8cfda78385e8e1fd8520f47172a2b17';
const reviewedCatalogRelease = 'catalog_release_20260928_v2';

export async function publishReviewedCatalog(
  transaction: Prisma.TransactionClient,
  catalog: DeploymentCatalog,
) {
  const hash = createHash('sha256')
    .update(JSON.stringify(catalog))
    .digest('hex');
  if (hash !== reviewedCatalogHash)
    throw new Error(
      'Catalog does not match the explicitly reviewed publication batch.',
    );
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(728401928)`;
  const previous = await transaction.setting.findUnique({
    where: { key: reviewedCatalogRelease },
  });
  if (previous)
    return { alreadyPublished: true, storesActivated: 0, productsPublished: 0 };

  const storeIds = catalog.stores.map((store) => store.id);
  const productIds = catalog.products.map((product) => product.id);
  const stores = await transaction.store.findMany({
    where: { id: { in: storeIds } },
    select: { id: true, status: true, deletedAt: true },
  });
  if (
    stores.length !== storeIds.length ||
    stores.some(
      (store) =>
        store.deletedAt ||
        !['APPLIED', 'UNDER_REVIEW', 'ACTIVE'].includes(store.status),
    )
  ) {
    throw new Error(
      'Reviewed catalog contains missing, deleted or ineligible stores; publication aborted.',
    );
  }
  const products = await transaction.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, storeId: true, status: true, deletedAt: true },
  });
  const ownership = new Map(
    catalog.products.map((product) => [product.id, product.storeId]),
  );
  if (
    products.length !== productIds.length ||
    products.some(
      (product) =>
        product.deletedAt ||
        ownership.get(product.id) !== product.storeId ||
        !['UNDER_REVIEW', 'APPROVED', 'PUBLISHED'].includes(product.status),
    )
  ) {
    throw new Error(
      'Reviewed catalog contains missing, reassigned or ineligible products; publication aborted.',
    );
  }
  const storeResult = await transaction.store.updateMany({
    where: {
      id: { in: storeIds },
      deletedAt: null,
      status: { in: ['APPLIED', 'UNDER_REVIEW'] },
    },
    data: { status: 'ACTIVE' },
  });
  const productResult = await transaction.product.updateMany({
    where: {
      id: { in: productIds },
      deletedAt: null,
      status: { in: ['UNDER_REVIEW', 'APPROVED'] },
    },
    data: { status: 'PUBLISHED' },
  });
  const result = {
    alreadyPublished: false,
    storesActivated: storeResult.count,
    productsPublished: productResult.count,
  };
  await transaction.setting.create({
    data: {
      key: reviewedCatalogRelease,
      value: {
        contentHash: hash,
        storeIds,
        productIds,
        completedAt: new Date().toISOString(),
      },
      description:
        'One-time owner-approved catalog publication, including labeled references and unconfirmed stock.',
    },
  });
  await transaction.auditLog.create({
    data: {
      entityType: 'catalog_release',
      entityId: randomUUID(),
      action: 'REVIEWED_CATALOG_PUBLISHED',
      channel: 'SYSTEM',
      reason:
        'Owner explicitly approved these 26 products for the read-only storefront on 2026-09-28. No checkout or verification evidence added.',
      metadata: {
        ...result,
        release: reviewedCatalogRelease,
        contentHash: hash,
        storesBefore: stores.map(({ id, status }) => ({ id, status })),
        productsBefore: products.map(({ id, status }) => ({ id, status })),
      },
    },
  });
  return result;
}
