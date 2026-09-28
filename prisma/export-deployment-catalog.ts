import 'dotenv/config';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  publicAttributes,
  type DeploymentCatalog,
} from './deployment-catalog.js';

const { values } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    version: { type: 'string', default: '2' },
  },
});
if (values.version !== '1' && values.version !== '2')
  throw new Error('Supported catalog versions: 1, 2.');
const version = values.version === '1' ? 1 : 2;

if (
  !['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST ?? '') ||
  process.env.RENDER === 'true' ||
  process.env.NODE_ENV === 'production'
) {
  throw new Error(
    'Catalog export is allowed only from the local development database.',
  );
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  }),
});
try {
  const catalog = await prisma.$transaction(
    async (transaction) => {
      const stores = await transaction.store.findMany({
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          displayName: true,
          legalName: true,
          gallery: true,
          standNumber: true,
          whatsappNumber: true,
          hours: {
            orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
            select: { dayOfWeek: true, opensAt: true, closesAt: true },
          },
        },
      });
      const products = await transaction.product.findMany({
        where: {
          deletedAt: null,
          storeId: { in: stores.map((store) => store.id) },
        },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          storeId: true,
          name: true,
          description: true,
          category: true,
          garmentType: true,
          unitPriceInCents: true,
          wholesalePriceInCents: true,
          wholesaleMinimum: true,
          attributes: true,
          status: true,
          productAttributes: {
            where: { code: { in: ['image_url', 'image_kind'] } },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
            select: { code: true, value: true, position: true },
          },
          variants: {
            orderBy: { id: 'asc' },
            select: {
              id: true,
              sku: true,
              sizeNormalized: true,
              sizeLabel: true,
              color: true,
              active: true,
              inventory: { select: { quantity: true, stockUpdatedAt: true } },
            },
          },
        },
      });
      const contacts = Object.fromEntries(
        stores.map((store) => [store.id, store.whatsappNumber]),
      );
      const data: DeploymentCatalog = {
        version,
        stores: stores.map(
          ({
            whatsappNumber: _privateContact,
            legalName,
            hours,
            ...store
          }) => ({
            ...store,
            ...(version === 2 ? { legalName } : {}),
            hours: hours.map((hour) => ({
              ...hour,
              opensAt: hour.opensAt.toISOString(),
              closesAt: hour.closesAt.toISOString(),
            })),
          }),
        ),
        products: products.map(
          ({
            attributes,
            productAttributes,
            variants,
            status,
            ...product
          }) => ({
            ...product,
            status: status === 'DRAFT' ? 'DRAFT' : 'UNDER_REVIEW',
            attributes: publicAttributes(attributes),
            images: productAttributes.filter((image) => {
              if (image.code === 'image_kind')
                return image.value === 'reference_only_not_actual_product';
              try {
                const url = new URL(image.value);
                return (
                  url.protocol === 'https:' && !url.username && !url.password
                );
              } catch {
                return false;
              }
            }),
            variants: variants.map(({ inventory, ...variant }) => ({
              ...variant,
              inventory: inventory
                ? {
                    quantity: inventory.quantity,
                    stockUpdatedAt: inventory.stockUpdatedAt.toISOString(),
                  }
                : null,
            })),
          }),
        ),
      };
      return { data, contacts };
    },
    { isolationLevel: 'RepeatableRead' },
  );
  const variants = catalog.data.products.flatMap((product) => product.variants);
  console.log(
    JSON.stringify({
      stores: catalog.data.stores.length,
      products: catalog.data.products.length,
      variants: variants.length,
      units: variants.reduce(
        (sum, variant) => sum + (variant.inventory?.quantity ?? 0),
        0,
      ),
      images: catalog.data.products
        .flatMap((product) => product.images)
        .filter((image) => image.code === 'image_url').length,
    }),
  );
  if (values.write) {
    const directory = new URL('./data/', import.meta.url);
    const output = new URL(`catalog-v${version}.json`, directory);
    const privateOutput = new URL(
      '../.env.catalog-production',
      import.meta.url,
    );
    for (const path of [output]) {
      const exists = await access(path).then(
        () => true,
        () => false,
      );
      if (exists)
        throw new Error(
          `Refusing to overwrite ${fileURLToPath(path)}. Review and version catalog changes explicitly.`,
        );
    }
    await mkdir(directory, { recursive: true });
    const privateExists = await access(privateOutput).then(
      () => true,
      () => false,
    );
    if (!privateExists) {
      await writeFile(
        privateOutput,
        `CATALOG_STORE_CONTACTS_JSON='${JSON.stringify(catalog.contacts)}'\n`,
        { flag: 'wx', mode: 0o600 },
      );
    }
    await writeFile(output, `${JSON.stringify(catalog.data, null, 2)}\n`, {
      flag: 'wx',
    });
    console.log(
      `Generated prisma/data/catalog-v${version}.json. Private contacts ${privateExists ? 'preserved; review separately if store contacts changed' : 'generated in ignored .env.catalog-production'}. No database changes.`,
    );
  }
} finally {
  await prisma.$disconnect();
}
