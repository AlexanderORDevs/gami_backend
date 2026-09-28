import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CatalogQueryDto } from './catalog.dto.js';

function publicSelect(now: Date) {
  return {
    id: true,
    name: true,
    description: true,
    category: true,
    attributes: true,
    unitPriceInCents: true,
    wholesalePriceInCents: true,
    wholesaleMinimum: true,
    store: { select: { id: true, displayName: true } },
    productAttributes: {
      where: { code: { in: ['image_url', 'image_kind'] } },
      orderBy: { position: 'asc' },
      select: { code: true, value: true },
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
  const imageUrls = [
    ...new Set(
      product.productAttributes
        .filter((attribute) => attribute.code === 'image_url')
        .map((attribute) => attribute.value)
        .filter((value) => {
          try {
            return new URL(value).protocol === 'https:';
          } catch {
            return false;
          }
        }),
    ),
  ];
  const imageUrl = imageUrls[0] ?? null;
  const attributes =
    product.attributes &&
    typeof product.attributes === 'object' &&
    !Array.isArray(product.attributes)
      ? product.attributes
      : {};
  const declaredSizes = Array.isArray(attributes.declared_sizes)
    ? attributes.declared_sizes.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const declaredColors = Array.isArray(attributes.declared_colors)
    ? attributes.declared_colors.flatMap((value) => {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof value.name !== 'string'
        )
          return [];
        return [
          {
            name: value.name,
            hex:
              typeof value.hex === 'string' && /^#[\da-f]{6}$/i.test(value.hex)
                ? value.hex
                : null,
          },
        ];
      })
    : [];
  const specifications = Object.fromEntries(
    ['material', 'fit', 'details', 'care'].flatMap((key) =>
      typeof attributes[key] === 'string' ? [[key, attributes[key]]] : [],
    ),
  );
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
    imageUrls,
    declaredSizes,
    declaredColors,
    specifications,
    stockKnown:
      product.variants.length > 0 &&
      product.variants.every((variant) => variant.inventory !== null),
    imageIsReference:
      Boolean(imageUrl) &&
      product.productAttributes.some(
        (attribute) =>
          attribute.code === 'image_kind' &&
          attribute.value === 'reference_only_not_actual_product',
      ),
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
  private readonly localPreview: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.localPreview =
      config.get<string>('CATALOG_LOCAL_PREVIEW') === 'true' &&
      config.get<string>('NODE_ENV') === 'development' &&
      ['localhost', '127.0.0.1', '::1'].includes(
        config.get<string>('DB_HOST', ''),
      ) &&
      config.get<string>('RENDER') !== 'true';
  }

  private productVisibility(): Prisma.ProductWhereInput {
    return {
      status: this.localPreview
        ? { in: ['PUBLISHED', 'UNDER_REVIEW'] }
        : 'PUBLISHED',
      deletedAt: null,
    };
  }

  private storeVisibility(): Prisma.StoreWhereInput {
    return {
      status: this.localPreview
        ? { in: ['ACTIVE', 'APPLIED', 'UNDER_REVIEW', 'PENDING_DOCUMENTS'] }
        : 'ACTIVE',
      deletedAt: null,
    };
  }

  private catalogVisibility(): Prisma.ProductWhereInput {
    return { ...this.productVisibility(), store: this.storeVisibility() };
  }

  async list(query: CatalogQueryDto) {
    const limit = 24;
    const where: Prisma.ProductWhereInput = {
      ...this.catalogVisibility(),
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
      where: { ...this.catalogVisibility(), id },
      select: publicSelect(new Date()),
    });
    if (!product) throw new NotFoundException('La prenda no está disponible.');
    return serializeProduct(product);
  }

  async filters() {
    const [categories, stores] = await Promise.all([
      this.prisma.product.findMany({
        where: this.catalogVisibility(),
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
      }),
      this.prisma.store.findMany({
        where: {
          ...this.storeVisibility(),
          products: { some: this.productVisibility() },
        },
        select: {
          id: true,
          displayName: true,
          _count: {
            select: {
              products: { where: this.productVisibility() },
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
