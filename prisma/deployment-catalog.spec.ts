import {
  publicAttributes,
  seedDeploymentCatalog,
  storeContacts,
  type DeploymentCatalog,
} from './deployment-catalog.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { seedBootstrap } from './seed.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const catalog: DeploymentCatalog = {
  version: 1,
  stores: [
    {
      id: 'store',
      displayName: 'Store',
      gallery: null,
      standNumber: null,
      hours: [],
    },
  ],
  products: [
    {
      id: 'product',
      storeId: 'store',
      name: 'Shirt',
      description: null,
      category: 'Tops',
      garmentType: 'Shirt',
      unitPriceInCents: 3500,
      wholesalePriceInCents: null,
      wholesaleMinimum: null,
      attributes: {},
      status: 'UNDER_REVIEW',
      images: [],
      variants: [
        {
          id: 'variant',
          sku: 'sku',
          sizeLabel: 'S',
          sizeNormalized: 'S',
          color: 'Black',
          active: true,
          inventory: {
            quantity: 12,
            stockUpdatedAt: '2026-09-25T12:00:00.000Z',
          },
        },
      ],
    },
  ],
};

function database() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    store: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        attributes: {},
        updatedAt: new Date('2026-09-28T00:00:00Z'),
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn() },
  };
}

describe('deployment catalog', () => {
  it('includes business identity and source details without exporting private attributes', async () => {
    expect(
      publicAttributes({
        stock_date_source: 'submission',
        catalog_web_id: '29',
        catalog_web_type: 'marca_aliada',
        bank: 'PRIVATE',
        email: 'PRIVATE',
      }),
    ).toEqual({
      stock_date_source: 'submission',
      catalog_web_id: '29',
      catalog_web_type: 'marca_aliada',
    });
    const transaction = database();
    transaction.store.findUnique.mockResolvedValue({
      id: 'store',
      deletedAt: null,
    });
    transaction.product.findUnique.mockResolvedValue({
      id: 'product',
      storeId: 'store',
      deletedAt: null,
    });
    transaction.product.findUniqueOrThrow.mockResolvedValue({
      attributes: { material: 'Edited', catalog_web_id: 'existing' },
      updatedAt: new Date('2026-09-28T00:00:00Z'),
    });
    transaction.store.updateMany.mockResolvedValue({ count: 1 });
    transaction.product.updateMany.mockResolvedValue({ count: 1 });
    const expanded: DeploymentCatalog = {
      ...catalog,
      version: 2,
      stores: [{ ...catalog.stores[0], legalName: 'Store SAC' }],
      products: [
        {
          ...catalog.products[0],
          attributes: { stock_date_source: 'submission', catalog_web_id: '29' },
        },
      ],
    };
    const result = await seedDeploymentCatalog(
      transaction as unknown as Prisma.TransactionClient,
      expanded,
      {},
    );
    expect(result).toMatchObject({ detailsEnriched: 2, productsCreated: 0 });
    expect(transaction.store.updateMany).toHaveBeenCalledWith({
      where: { id: 'store', legalName: null, deletedAt: null },
      data: { legalName: 'Store SAC' },
    });
    expect(transaction.product.updateMany.mock.calls[0][0].data).toEqual({
      attributes: {
        material: 'Edited',
        catalog_web_id: 'existing',
        stock_date_source: 'submission',
      },
    });
  });
  it('exports only public attribute fields, including sanitized nested options', () => {
    expect(
      publicAttributes({
        material: 'Cotton',
        bank: 'PRIVATE',
        email: 'PRIVATE',
        commission: 15,
        declared_sizes: ['S', { private: true }],
        declared_colors: [
          { name: 'Black', hex: '#000000', account: 'PRIVATE' },
        ],
      }),
    ).toEqual({
      material: 'Cotton',
      declared_sizes: ['S'],
      declared_colors: [{ name: 'Black', hex: '#000000' }],
    });
  });

  it('rejects malformed contacts without leaking their contents', () => {
    expect(storeContacts(undefined, catalog)).toEqual({});
    expect(storeContacts('{"store":"+51900000001"}', catalog)).toEqual({
      store: '+51900000001',
    });
    expect(() => storeContacts('SECRET', catalog)).toThrow(
      'must be a JSON object',
    );
    expect(() => storeContacts('{"unknown":"+51900000001"}', catalog)).toThrow(
      'Invalid store identity',
    );
  });

  it('requires private contacts only when creating a store', async () => {
    const transaction = database();
    await expect(
      seedDeploymentCatalog(
        transaction as unknown as Prisma.TransactionClient,
        catalog,
        {},
      ),
    ).rejects.toThrow('CATALOG_STORE_CONTACTS_JSON');
    expect(transaction.store.create).not.toHaveBeenCalled();
    expect(transaction.product.create).not.toHaveBeenCalled();
  });

  it('creates review-only records with original stock timestamps and opening movements', async () => {
    const transaction = database();
    const result = await seedDeploymentCatalog(
      transaction as unknown as Prisma.TransactionClient,
      catalog,
      { store: '+51900000001' },
    );
    expect(result).toEqual({
      storesCreated: 1,
      productsCreated: 1,
      productsPreserved: 0,
      variantsCreated: 1,
    });
    expect(transaction.store.create.mock.calls[0][0].data.status).toBe(
      'APPLIED',
    );
    const data = transaction.product.create.mock.calls[0][0].data;
    expect(data.status).toBe('UNDER_REVIEW');
    expect(data.variants.create[0].inventory.create).toEqual({
      quantity: 12,
      stockUpdatedAt: new Date('2026-09-25T12:00:00.000Z'),
    });
    expect(data.variants.create[0].stockMovements.create.balanceAfter).toBe(12);
  });

  it('preserves existing stores, products and inventory on every subsequent deploy', async () => {
    const transaction = database();
    transaction.store.findUnique.mockResolvedValue({
      id: 'store',
      status: 'SUSPENDED',
      deletedAt: null,
    });
    transaction.product.findUnique.mockResolvedValue({
      id: 'product',
      storeId: 'store',
      status: 'PUBLISHED',
      deletedAt: null,
    });
    const result = await seedDeploymentCatalog(
      transaction as unknown as Prisma.TransactionClient,
      catalog,
      {},
    );
    expect(result.productsPreserved).toBe(1);
    expect(transaction.store.create).not.toHaveBeenCalled();
    expect(transaction.product.create).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses name/contact collisions and ownership mismatches instead of merging', async () => {
    const transaction = database();
    transaction.store.findFirst.mockResolvedValue({ id: 'other' });
    await expect(
      seedDeploymentCatalog(
        transaction as unknown as Prisma.TransactionClient,
        catalog,
        { store: '+51900000001' },
      ),
    ).rejects.toThrow('identity conflict');
    transaction.store.findUnique.mockResolvedValue({
      id: 'store',
      deletedAt: null,
    });
    transaction.product.findUnique.mockResolvedValue({
      id: 'product',
      storeId: 'other',
      deletedAt: null,
    });
    await expect(
      seedDeploymentCatalog(
        transaction as unknown as Prisma.TransactionClient,
        catalog,
        {},
      ),
    ).rejects.toThrow('identity conflict');
  });
});

describe('deployment bootstrap', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not reactivate existing administrators, reset credentials, regrant removed roles or overwrite settings', async () => {
    vi.stubEnv('INITIAL_ADMIN_USERNAME', 'existing-admin');
    vi.stubEnv('INITIAL_ADMIN_PASSWORD', '');
    vi.stubEnv('INITIAL_ADMIN_DISPLAY_NAME', '');
    const transaction = {
      role: {
        upsert: vi.fn().mockImplementation(async ({ create }) => ({
          ...create,
          id: create.code,
        })),
      },
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'admin', status: 'SUSPENDED' }),
        create: vi.fn(),
        update: vi.fn(),
      },
      userRole: { create: vi.fn() },
      setting: { upsert: vi.fn() },
    };
    await seedBootstrap(transaction as unknown as Prisma.TransactionClient);
    expect(transaction.user.create).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(transaction.userRole.create).not.toHaveBeenCalled();
    expect(transaction.setting.upsert).toHaveBeenCalledTimes(6);
    for (const [input] of transaction.setting.upsert.mock.calls)
      expect(input.update).toEqual({});
  });
});

describe('committed deployment snapshot', () => {
  it('contains the reviewed catalog, source stock dates and no private payload fields', async () => {
    const data = JSON.parse(
      await readFile(
        new URL('./data/catalog-v2.json', import.meta.url),
        'utf8',
      ),
    ) as DeploymentCatalog;
    expect(data.stores).toHaveLength(3);
    expect(data.version).toBe(2);
    expect(data.stores.filter((store) => store.legalName)).toHaveLength(2);
    expect(
      data.products.filter((product) => product.attributes.stock_date_source),
    ).toHaveLength(6);
    expect(
      data.products.filter((product) => product.attributes.catalog_web_id),
    ).toHaveLength(20);
    expect(data.products).toHaveLength(26);
    const variants = data.products.flatMap((product) => product.variants);
    expect(variants).toHaveLength(74);
    expect(
      variants.reduce(
        (sum, variant) => sum + (variant.inventory?.quantity ?? 0),
        0,
      ),
    ).toBe(821);
    expect(
      data.products
        .flatMap((product) => product.images)
        .filter((image) => image.code === 'image_url'),
    ).toHaveLength(73);
    expect(
      data.products.filter((product) => product.variants.length === 0),
    ).toHaveLength(20);
    expect(
      data.products.every((product) => product.status === 'UNDER_REVIEW'),
    ).toBe(true);
    const json = JSON.stringify(data);
    for (const forbidden of [
      'whatsappNumber',
      'passwordHash',
      'email',
      'bank',
      'snapshot',
      'commission',
    ])
      expect(json).not.toContain(`"${forbidden}"`);
    for (const product of data.products)
      expect(publicAttributes(product.attributes as Prisma.JsonValue)).toEqual(
        product.attributes,
      );
  });
});

describe.skipIf(process.env.RUN_CATALOG_DEPLOYMENT_INTEGRATION !== '1')(
  'local PostgreSQL deployment integration',
  () => {
    it('loads a complete catalog, preserves changed data on replay and rolls back all test writes', async () => {
      if (
        !['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST ?? '')
      )
        throw new Error('Integration test requires a local database.');
      const { PrismaClient } =
        await import('../src/generated/prisma/client.js');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const prisma = new PrismaClient({
        adapter: new PrismaPg({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        }),
      });
      const data = JSON.parse(
        await readFile(
          new URL('./data/catalog-v2.json', import.meta.url),
          'utf8',
        ),
      ) as DeploymentCatalog;
      const identities = new Map(
        data.stores.map((store) => [store.id, randomUUID()]),
      );
      const fixture: DeploymentCatalog = {
        ...data,
        stores: data.stores.map((store) => ({
          ...store,
          id: identities.get(store.id)!,
          displayName: `Deployment test ${identities.get(store.id)}`,
        })),
        products: data.products.map((product) => ({
          ...product,
          id: randomUUID(),
          storeId: identities.get(product.storeId)!,
          variants: product.variants.map((variant) => ({
            ...variant,
            id: randomUUID(),
            sku: `test-${randomUUID()}`,
          })),
        })),
      };
      const contacts = Object.fromEntries(
        fixture.stores.map((store, index) => [store.id, `+5990000000${index}`]),
      );
      const legacy: DeploymentCatalog = {
        ...fixture,
        version: 1,
        stores: fixture.stores.map(
          ({ legalName: _excluded, ...store }) => store,
        ),
        products: fixture.products.map((product) => ({
          ...product,
          attributes: Object.fromEntries(
            Object.entries(product.attributes).filter(
              ([key]) =>
                ![
                  'stock_date_source',
                  'catalog_web_id',
                  'catalog_web_type',
                ].includes(key),
            ),
          ) as Prisma.InputJsonObject,
        })),
      };
      const rollback = new Error('Intentional integration rollback');
      try {
        const before = {
          stores: await prisma.store.count(),
          products: await prisma.product.count(),
          units: (
            await prisma.inventory.aggregate({ _sum: { quantity: true } })
          )._sum.quantity,
        };
        await expect(
          prisma.$transaction(
            async (transaction) => {
              const first = await seedDeploymentCatalog(
                transaction,
                legacy,
                contacts,
              );
              expect(first).toEqual({
                storesCreated: 3,
                productsCreated: 26,
                productsPreserved: 0,
                variantsCreated: 74,
              });
              const productIds = fixture.products.map((product) => product.id);
              const variantIds = fixture.products.flatMap((product) =>
                product.variants.map((variant) => variant.id),
              );
              expect(
                (
                  await transaction.inventory.aggregate({
                    where: { variantId: { in: variantIds } },
                    _sum: { quantity: true },
                  })
                )._sum.quantity,
              ).toBe(821);
              expect(
                await transaction.stockMovement.count({
                  where: { variantId: { in: variantIds } },
                }),
              ).toBe(74);
              expect(
                await transaction.productAttribute.count({
                  where: { productId: { in: productIds }, code: 'image_url' },
                }),
              ).toBe(73);
              await transaction.product.update({
                where: { id: productIds[0] },
                data: {
                  status: 'PUBLISHED',
                  unitPriceInCents: 12345,
                  attributes: {
                    material: 'Production edit',
                    custom: 'Preserved',
                  },
                },
              });
              await transaction.inventory.update({
                where: { variantId: variantIds[0] },
                data: { quantity: 2 },
              });
              const second = await seedDeploymentCatalog(
                transaction,
                fixture,
                {},
              );
              expect(second).toEqual({
                storesCreated: 0,
                productsCreated: 0,
                productsPreserved: 26,
                variantsCreated: 0,
                detailsEnriched: 28,
              });
              for (const source of fixture.stores) {
                expect(
                  await transaction.store.findUnique({
                    where: { id: source.id },
                  }),
                ).toMatchObject({ legalName: source.legalName });
              }
              for (const source of fixture.products) {
                const saved = await transaction.product.findUniqueOrThrow({
                  where: { id: source.id },
                });
                expect(saved.attributes).toMatchObject(
                  Object.fromEntries(
                    Object.entries(source.attributes).filter(([key]) =>
                      [
                        'stock_date_source',
                        'catalog_web_id',
                        'catalog_web_type',
                      ].includes(key),
                    ),
                  ),
                );
              }
              const third = await seedDeploymentCatalog(
                transaction,
                fixture,
                {},
              );
              expect(third).toEqual({
                storesCreated: 0,
                productsCreated: 0,
                productsPreserved: 26,
                variantsCreated: 0,
              });
              expect(
                await transaction.product.findUnique({
                  where: { id: productIds[0] },
                }),
              ).toMatchObject({
                status: 'PUBLISHED',
                unitPriceInCents: 12345,
                attributes: {
                  material: 'Production edit',
                  custom: 'Preserved',
                },
              });
              expect(
                await transaction.inventory.findUnique({
                  where: { variantId: variantIds[0] },
                }),
              ).toMatchObject({ quantity: 2 });
              throw rollback;
            },
            { timeout: 120000 },
          ),
        ).rejects.toBe(rollback);
        await expect(
          prisma.$transaction((transaction) =>
            seedDeploymentCatalog(transaction, fixture, {
              [fixture.stores[0].id]: contacts[fixture.stores[0].id],
            }),
          ),
        ).rejects.toThrow('CATALOG_STORE_CONTACTS_JSON');
        expect(await prisma.store.count()).toBe(before.stores);
        expect(await prisma.product.count()).toBe(before.products);
        expect(
          (await prisma.inventory.aggregate({ _sum: { quantity: true } }))._sum
            .quantity,
        ).toBe(before.units);
      } finally {
        await prisma.$disconnect();
      }
    }, 120000);
  },
);
