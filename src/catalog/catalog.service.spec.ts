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
    product: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    store: { findMany: vi.fn() },
  };
  const service = new CatalogService(
    prisma as unknown as PrismaService,
    new ConfigService({}),
  );

  beforeEach(() => vi.resetAllMocks());

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
        take: 24,
        skip: 0,
      }),
    );
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

  it('returns 404 for unpublished or unavailable product detail', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.detail('hidden')).rejects.toThrow(
      'La prenda no está disponible.',
    );
    expect(prisma.product.findFirst.mock.calls[0][0].where.status).toBe(
      'PUBLISHED',
    );
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
    prisma.product.findMany.mockResolvedValue([{ category: 'Blusas' }]);
    prisma.store.findMany.mockResolvedValue([
      { id: 'small', displayName: 'Una', _count: { products: 1 } },
      { id: 'ready', displayName: 'Tres', _count: { products: 3 } },
    ]);
    expect(await service.filters()).toEqual({
      categories: ['Blusas'],
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
      expect(prisma.product.findMany.mock.calls[0][0].where).toEqual(expected);
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
