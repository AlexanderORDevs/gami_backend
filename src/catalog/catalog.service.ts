import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CatalogQueryDto } from './catalog.dto.js';

const publishedWhere = {
  status: 'PUBLISHED',
  deletedAt: null,
  store: { status: 'ACTIVE', deletedAt: null },
} satisfies Prisma.ProductWhereInput;

function publicSelect(now: Date) {
  return {
    id: true,
    name: true,
    description: true,
    category: true,
    unitPriceInCents: true,
    wholesalePriceInCents: true,
    wholesaleMinimum: true,
    store: { select: { id: true, displayName: true } },
    productAttributes: {
      where: { code: 'image_url' },
      orderBy: { position: 'asc' },
      take: 1,
      select: { value: true },
    },
    variants: {
      where: { active: true },
      select: {
        id: true,
        sizeLabel: true,
        color: true,
        inventory: { select: { quantity: true, stockUpdatedAt: true } },
        stockHolds: {
          where: {
            OR: [
              { status: 'FIRM' },
              {
                status: 'LIVE',
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
            ],
          },
          select: { quantity: true },
        },
      },
    },
  } as const satisfies Prisma.ProductSelect;
}

type PublicProduct = Prisma.ProductGetPayload<{
  select: ReturnType<typeof publicSelect>;
}>;

function serializeProduct(product: PublicProduct) {
  const rawImage = product.productAttributes[0]?.value;
  let imageUrl: string | null = null;
  try {
    if (rawImage && new URL(rawImage).protocol === 'https:')
      imageUrl = rawImage;
  } catch {
    imageUrl = null;
  }
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    unitPriceInCents: product.unitPriceInCents,
    wholesalePriceInCents: product.wholesalePriceInCents,
    wholesaleMinimum: product.wholesaleMinimum,
    store: product.store,
    imageUrl,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      size: variant.sizeLabel,
      color: variant.color,
      availableStock: Math.max(
        0,
        (variant.inventory?.quantity ?? 0) -
          variant.stockHolds.reduce((total, hold) => total + hold.quantity, 0),
      ),
      stockUpdatedAt: variant.inventory?.stockUpdatedAt ?? null,
    })),
  };
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CatalogQueryDto) {
    const limit = 24;
    const where: Prisma.ProductWhereInput = {
      ...publishedWhere,
      ...(query.category ? { category: query.category } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.search?.trim()
        ? {
            OR: [
              { name: { contains: query.search.trim(), mode: 'insensitive' } },
              {
                store: {
                  displayName: {
                    contains: query.search.trim(),
                    mode: 'insensitive',
                  },
                },
              },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      query.sort === 'newest'
        ? [{ createdAt: 'desc' }, { id: 'asc' }]
        : [
            { unitPriceInCents: query.sort === 'price-asc' ? 'asc' : 'desc' },
            { id: 'asc' },
          ];
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * limit,
        take: limit,
        select: publicSelect(new Date()),
      }),
      this.prisma.product.count({ where }),
    ]);
    return {
      data: products.map(serializeProduct),
      total,
      page: query.page,
      pages: Math.ceil(total / limit),
    };
  }

  async detail(id: string) {
    const product = await this.prisma.product.findFirst({
      where: { ...publishedWhere, id },
      select: publicSelect(new Date()),
    });
    if (!product) throw new NotFoundException('La prenda no está disponible.');
    return serializeProduct(product);
  }

  async filters() {
    const [categories, stores] = await Promise.all([
      this.prisma.product.findMany({
        where: publishedWhere,
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
      }),
      this.prisma.store.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          products: { some: { status: 'PUBLISHED', deletedAt: null } },
        },
        select: {
          id: true,
          displayName: true,
          _count: {
            select: {
              products: { where: { status: 'PUBLISHED', deletedAt: null } },
            },
          },
        },
        orderBy: { displayName: 'asc' },
      }),
    ]);
    return {
      categories: categories.map((entry) => entry.category),
      stores: stores
        .filter((store) => store._count.products >= 3)
        .map((store) => ({ id: store.id, displayName: store.displayName })),
    };
  }
}
