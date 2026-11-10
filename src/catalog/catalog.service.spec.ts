import { CatalogService } from './catalog.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CatalogQueryDto } from './catalog.dto.js';
import { ConfigService } from '@nestjs/config';

describe('CatalogService', () => {
  const product = {
    id: 'product-id',
    name: 'Blusa',
    description: null,
    category: 'Blusas',
    attributes: null,
    unitPriceInCents: 4500,
    wholesalePriceInCents: null,
    wholesaleMinimum: null,
    store: { id: 'store-id', displayName: 'Marca' },
    productAttributes: [{ code: 'image_url', value: 'javascript:alert(1)' }],
    variants: [
      {
        id: 'variant-id',
        sizeLabel: 'M',
        color: 'Azul',
        inventory: { quantity: 5, stockUpdatedAt: new Date() },
        stockHolds: [{ quantity: 2 }],
      },
    ],
  };
  const prisma = {
    $queryRaw: vi.fn(),
    product: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    store: { findMany: vi.fn() },
  };
  const service = new CatalogService(
    prisma as unknown as PrismaService,
    new ConfigService({}),
  );

  beforeEach(() => {
    vi.resetAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ id: product.id }]);
  });

  it('filters public data, paginates and subtracts active reservations without exposing private fields', async () => {
    prisma.product.findMany.mockResolvedValue([product]);
    prisma.product.count.mockResolvedValue(1);
    const result = await service.list({
      ...new CatalogQueryDto(),
      search: 'Blusa',
    });
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PUBLISHED',
          deletedAt: null,
          store: { status: 'ACTIVE', deletedAt: null },
        }),
      }),
    );
    expect(prisma.$queryRaw.mock.calls[0][0].text).toContain(
      'ORDER BY available DESC',
    );
    expect(prisma.$queryRaw.mock.calls[0][0].values).toContain(24);
    expect(result.data[0].variants[0].availableStock).toBe(3);
    expect(result.data[0].imageUrl).toBeNull();
    expect(result.data[0]).not.toHaveProperty('productAttributes');
    expect(result.data[0].variants[0]).not.toHaveProperty('stockHolds');
    const select = prisma.product.findMany.mock.calls[0][0].select;
    expect(select.variants.where).toEqual({ active: true });
    expect(select.variants.select.stockHolds.where.OR).toEqual([
      { status: 'FIRM' },
      {
        status: 'LIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
    ]);
    expect(select.store.select).toEqual({ id: true, displayName: true });
  });

  it('filters by normalized garment type and audience while preserving matching count and stock ranking', async () => {
    const classified = {
      ...product,
      category: 'Mujer',
      garmentType: 'Top',
      attributes: { genero: 'mujer' },
    };
    prisma.product.findMany.mockResolvedValue([classified]);
    prisma.product.count.mockResolvedValue(1);
    const result = await service.list({
      ...new CatalogQueryDto(),
      category: 'tops',
      gender: 'mujer',
    });
    expect(result.data[0]).toMatchObject({ category: 'tops', gender: 'mujer' });
    const where = prisma.product.count.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          garmentType: expect.objectContaining({
            in: expect.arrayContaining(['top', 'tops']),
          }),
        }),
        expect.objectContaining({
          OR: expect.arrayContaining([
            { attributes: { path: ['genero'], equals: 'mujer' } },
            { category: { equals: 'mujer', mode: 'insensitive' } },
          ]),
        }),
      ]),
    );
    const rankedQuery = prisma.$queryRaw.mock.calls[0][0];
    expect(rankedQuery.text).toContain('LOWER(p.garment_type) IN');
    expect(rankedQuery.text).toContain("p.attributes ->> 'genero'");
    expect(rankedQuery.values).toContain('mujer');
    expect(rankedQuery.values).toContain('top');
  });

  it('returns 404 for unpublished or unavailable product detail', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.detail('hidden')).rejects.toThrow(
      'La prenda no está disponible.',
    );
    expect(prisma.product.findFirst.mock.calls[0][0].where.status).toBe(
      'PUBLISHED',
    );
  });

  it('preserves the availability ranking even if product hydration returns rows in a different order', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'ranked-first' },
      { id: product.id },
    ]);
    prisma.product.findMany.mockResolvedValue([
      product,
      { ...product, id: 'ranked-first' },
    ]);
    prisma.product.count.mockResolvedValue(2);
    const result = await service.list({
      ...new CatalogQueryDto(),
      sort: 'price-asc',
      page: 2,
    });
    expect(result.data.map((item) => item.id)).toEqual([
      'ranked-first',
      product.id,
    ]);
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.text).toContain(
      'ORDER BY available DESC, unit_price_in_cents ASC, id ASC',
    );
    expect(query.values.slice(-2)).toEqual([24, 24]);
  });

  it('returns ordered galleries and declared options without exposing private attributes or inventing stock', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...product,
      variants: [],
      attributes: {
        declared_sizes: ['S', 'M'],
        declared_colors: [{ name: 'Negro', hex: '#111111' }],
        material: 'Algodon',
        commission: 12,
        bank: 'private',
      },
      productAttributes: [
        { code: 'image_url', value: 'https://example.com/cover.jpg' },
        { code: 'image_url', value: 'https://example.com/other.jpg' },
        { code: 'image_url', value: 'javascript:alert(1)' },
        { code: 'image_url', value: 'https://example.com/cover.jpg' },
      ],
    });
    const result = await service.detail('product-id');
    expect(result.imageUrls).toEqual([
      'https://example.com/cover.jpg',
      'https://example.com/other.jpg',
    ]);
    expect(result.imageUrl).toBe(result.imageUrls[0]);
    expect(result.stockKnown).toBe(false);
    expect(result.variants).toEqual([]);
    expect(result.declaredSizes).toEqual(['S', 'M']);
    expect(result.declaredColors).toEqual([{ name: 'Negro', hex: '#111111' }]);
    expect(result.specifications).toEqual({ material: 'Algodon' });
    expect(result).not.toHaveProperty('attributes');
    expect(result).not.toHaveProperty('commission');
    expect(result).not.toHaveProperty('bank');
  });

  it('identifies reference images without exposing unrelated product attributes', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...product,
      productAttributes: [
        { code: 'image_kind', value: 'reference_only_not_actual_product' },
        {
          code: 'image_url',
          value: 'https://images.example.com/reference.jpg',
        },
      ],
    });
    const result = await service.detail('product-id');
    expect(result.imageUrl).toBe('https://images.example.com/reference.jpg');
    expect(result.imageIsReference).toBe(true);
    expect(result).not.toHaveProperty('productAttributes');
    expect(
      prisma.product.findFirst.mock.calls[0][0].select.productAttributes.where,
    ).toEqual({ code: { in: ['image_url', 'image_kind'] } });
  });

  it('never returns negative stock or raw inventory', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...product,
      variants: [{ ...product.variants[0], stockHolds: [{ quantity: 9 }] }],
    });
    const result = await service.detail('product-id');
    expect(result.variants[0].availableStock).toBe(0);
    expect(result.variants[0]).not.toHaveProperty('inventory');
  });

  it('lists brands only when they have at least three published products', async () => {
    prisma.product.findMany.mockResolvedValue([
      {
        category: 'Mujer',
        garmentType: 'Top',
        attributes: { genero: 'mujer' },
      },
    ]);
    prisma.store.findMany.mockResolvedValue([
      { id: 'small', displayName: 'Una', _count: { products: 1 } },
      { id: 'ready', displayName: 'Tres', _count: { products: 3 } },
    ]);
    expect(await service.filters()).toEqual({
      categories: ['tops'],
      genders: ['mujer'],
      stores: [{ id: 'ready', displayName: 'Tres' }],
    });
  });

  it('previews review products consistently in lists, details, categories and brands on local development', async () => {
    const preview = new CatalogService(
      prisma as unknown as PrismaService,
      new ConfigService({
        CATALOG_LOCAL_PREVIEW: 'true',
        NODE_ENV: 'development',
        DB_HOST: 'localhost',
        RENDER: 'false',
      }),
    );
    prisma.product.findMany.mockResolvedValue([product]);
    prisma.product.count.mockResolvedValue(1);
    prisma.product.findFirst.mockResolvedValue(product);
    prisma.store.findMany.mockResolvedValue([]);
    await preview.list({
      ...new CatalogQueryDto(),
      search: 'Blusa',
      category: 'Blusas',
    });
    await preview.detail('product-id');
    await preview.filters();
    const expected = {
      status: { in: ['PUBLISHED', 'UNDER_REVIEW'] },
      deletedAt: null,
      store: {
        status: {
          in: ['ACTIVE', 'APPLIED', 'UNDER_REVIEW', 'PENDING_DOCUMENTS'],
        },
        deletedAt: null,
      },
    };
    for (const call of prisma.product.findMany.mock.calls)
      expect(call[0].where).toEqual(expect.objectContaining(expected));
    expect(prisma.product.count.mock.calls[0][0].where).toEqual(
      expect.objectContaining(expected),
    );
    expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
      ...expected,
      id: 'product-id',
    });
    const storeQuery = prisma.store.findMany.mock.calls[0][0];
    expect(storeQuery.where).toEqual({
      ...expected.store,
      products: { some: { status: expected.status, deletedAt: null } },
    });
    expect(storeQuery.select._count.select.products.where).toEqual({
      status: expected.status,
      deletedAt: null,
    });
  });

  it.each([
    {
      NODE_ENV: 'production',
      DB_HOST: 'localhost',
      CATALOG_LOCAL_PREVIEW: 'true',
      RENDER: 'false',
    },
    {
      NODE_ENV: 'development',
      DB_HOST: 'remote.example',
      CATALOG_LOCAL_PREVIEW: 'true',
      RENDER: 'false',
    },
    {
      NODE_ENV: 'development',
      DB_HOST: 'localhost',
      CATALOG_LOCAL_PREVIEW: 'false',
      RENDER: 'false',
    },
    {
      NODE_ENV: 'development',
      DB_HOST: 'localhost',
      CATALOG_LOCAL_PREVIEW: 'true',
      RENDER: 'true',
    },
  ])(
    'keeps unpublished data private when preview is not allowed: %j',
    async (environment) => {
      const restricted = new CatalogService(
        prisma as unknown as PrismaService,
        new ConfigService(environment),
      );
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.store.findMany.mockResolvedValue([]);
      await restricted.list(new CatalogQueryDto());
      await expect(restricted.detail('hidden')).rejects.toThrow();
      await restricted.filters();
      const expected = {
        status: 'PUBLISHED',
        deletedAt: null,
        store: { status: 'ACTIVE', deletedAt: null },
      };
      expect(prisma.product.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining(expected),
      );
      expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
        ...expected,
        id: 'hidden',
      });
      expect(prisma.store.findMany.mock.calls[0][0].where.status).toBe(
        'ACTIVE',
      );
    },
  );
});

it.skipIf(process.env.RUN_CATALOG_STOCK_INTEGRATION !== '1')(
  'sorts net availability globally before pagination with all filters and price modes, then rolls back',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { parse } = await import('dotenv');
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const database = new PrismaService(new ConfigService(environment));
    const prefix = `stock-rank-${randomUUID()}`;
    const category = prefix.replaceAll('-', '_');
    const rollback = new Error('Rollback availability ranking fixtures');
    try {
      await expect(
        database.$transaction(
          async (transaction) => {
            const store = await transaction.store.create({
              data: {
                displayName: prefix,
                whatsappNumber: prefix.slice(0, 27),
                status: 'ACTIVE',
              },
            });
            const customer = await transaction.customer.create({
              data: {
                fullName: prefix,
                phone: '999111222',
                addresses: {
                  create: {
                    recipientName: 'Stock fixture',
                    recipientPhone: '999111222',
                    zoneType: 'LIMA',
                    city: 'Lima',
                    line1: 'Local test only',
                  },
                },
              },
              include: { addresses: true },
            });
            const order = await transaction.order.create({
              data: {
                orderNumber: `S-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
                customerId: customer.id,
                shippingAddressId: customer.addresses[0].id,
                subtotalInCents: 100,
                shippingInCents: 0,
                totalInCents: 100,
              },
            });
            const availableIndices = [25, 27, 30, 35];
            const records: { id: string; index: number; price: number }[] = [];
            for (let index = 0; index < 36; index++) {
              const available = availableIndices.includes(index);
              const price = (available ? 20000 : 1000) + index;
              const product = await transaction.product.create({
                data: {
                  storeId: store.id,
                  name: `${prefix}-${index}`,
                  category,
                  garmentType: category,
                  unitPriceInCents: price,
                  status: 'PUBLISHED',
                  createdAt: new Date(Date.UTC(2025, 0, 1, 0, index)),
                },
              });
              records.push({ id: product.id, index, price });
              if (index < 25) continue;
              const variant = await transaction.variant.create({
                data: {
                  productId: product.id,
                  sku: `${prefix}-${index}`,
                  sizeLabel: 'M',
                  sizeNormalized: 'M',
                  color: 'Azul',
                  active: index !== 32,
                  inventory: {
                    create: {
                      quantity: index === 34 ? 0 : 5,
                      needsReview: index === 31,
                    },
                  },
                },
              });
              if (index === 33)
                await transaction.variant.create({
                  data: {
                    productId: product.id,
                    sku: `${prefix}-unknown`,
                    sizeLabel: 'L',
                    sizeNormalized: 'L',
                    color: 'Azul',
                  },
                });
              if ([26, 27, 28, 29, 30, 35].includes(index))
                await transaction.stockHold.create({
                  data: {
                    variantId: variant.id,
                    orderId: order.id,
                    quantity: index === 35 ? 3 : 5,
                    status:
                      index === 30
                        ? 'RELEASED'
                        : [26, 28, 35].includes(index)
                          ? 'FIRM'
                          : 'LIVE',
                    expiresAt: [26, 27, 35].includes(index)
                      ? new Date(Date.now() - 60000)
                      : index === 28
                        ? null
                        : new Date(Date.now() + 600000),
                  },
                });
            }
            const catalog = new CatalogService(
              transaction as unknown as PrismaService,
              new ConfigService({
                NODE_ENV: 'production',
                CATALOG_LOCAL_PREVIEW: 'false',
              }),
            );
            for (const sort of ['newest', 'price-asc', 'price-desc'] as const) {
              const query = {
                ...new CatalogQueryDto(),
                search: prefix,
                storeId: store.id,
                category,
                sort,
              };
              const first = await catalog.list(query);
              const second = await catalog.list({ ...query, page: 2 });
              expect(first.total).toBe(36);
              expect(first.pages).toBe(2);
              expect(first.data).toHaveLength(24);
              expect(second.data).toHaveLength(12);
              const all = [...first.data, ...second.data];
              expect(new Set(all.map((item) => item.id)).size).toBe(36);
              const availability = all.map(
                (item) =>
                  item.stockKnown &&
                  item.variants.some((variant) => variant.availableStock > 0),
              );
              expect(availability.slice(0, 4)).toEqual([
                true,
                true,
                true,
                true,
              ]);
              expect(availability.slice(4).some(Boolean)).toBe(false);
              const flagged = all.find((item) => item.id === records[31].id)!;
              expect(flagged.stockKnown).toBe(false);
              expect(flagged.variants[0].availableStock).toBe(0);
              const expected = records
                .filter((record) => availableIndices.includes(record.index))
                .sort((left, right) =>
                  sort === 'price-asc'
                    ? left.price - right.price
                    : right.price - left.price,
                );
              expect(all.slice(0, 4).map((item) => item.id)).toEqual(
                expected.map((record) => record.id),
              );
            }
            expect(
              (
                await catalog.list({
                  ...new CatalogQueryDto(),
                  search: 'no matching fixture',
                  storeId: store.id,
                })
              ).total,
            ).toBe(0);
            expect(
              (
                await catalog.list({
                  ...new CatalogQueryDto(),
                  category: 'no category',
                  storeId: store.id,
                })
              ).data,
            ).toEqual([]);
            const wildcard = await catalog.list({
              ...new CatalogQueryDto(),
              search: `${prefix}%`,
              storeId: store.id,
            });
            expect(wildcard.total).toBe(36);
            expect(wildcard.data).toHaveLength(24);
            await transaction.store.update({
              where: { id: store.id },
              data: { status: 'SUSPENDED' },
            });
            expect(
              (
                await catalog.list({
                  ...new CatalogQueryDto(),
                  storeId: store.id,
                })
              ).total,
            ).toBe(0);
            throw rollback;
          },
          { timeout: 90000 },
        ),
      ).rejects.toThrow(rollback.message);
      expect(
        await database.store.count({ where: { displayName: prefix } }),
      ).toBe(0);
    } finally {
      await database.$disconnect();
    }
  },
  100000,
);
