import { CatalogService } from './catalog.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CatalogQueryDto } from './catalog.dto.js';

describe('CatalogService', () => {
  const product = {
    id: 'product-id',
    name: 'Blusa',
    description: null,
    category: 'Blusas',
    unitPriceInCents: 4500,
    wholesalePriceInCents: null,
    wholesaleMinimum: null,
    store: { id: 'store-id', displayName: 'Marca' },
    productAttributes: [{ value: 'javascript:alert(1)' }],
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
  const service = new CatalogService(prisma as unknown as PrismaService);

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
});
