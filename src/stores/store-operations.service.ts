import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedUser, RequestContext } from '../auth/auth.types.js';
import {
  StoreAccessService,
  STORE_WRITE_PERMISSIONS,
  type StoreOperation,
} from './store-access.service.js';
import {
  PRODUCT_TYPES,
  type CreateStoreProductDto,
  type CreateStoreOrderDto,
  type CreateStoreShipmentDto,
  type AdjustStoreInventoryDto,
} from './store-operations.dto.js';

@Injectable()
export class StoreOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: StoreAccessService,
  ) {}

  private async authorize(
    transaction: Prisma.TransactionClient,
    storeId: string,
    actor: AuthenticatedUser,
    operation: StoreOperation,
  ) {
    const role = await this.access.require(
      storeId,
      actor,
      operation,
      transaction,
    );
    if (!STORE_WRITE_PERMISSIONS[role].includes(operation))
      throw new ForbiddenException(
        'No tienes permiso para modificar este modulo de la tienda.',
      );
  }

  private async write<T>(
    storeId: string,
    actor: AuthenticatedUser,
    operation: StoreOperation,
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:store-members:' + storeId}))`;
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:store-operations:' + storeId}))`;
          await this.authorize(transaction, storeId, actor, operation);
          return callback(transaction);
        },
        { timeout: 20000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'El registro ya existe. Actualiza la lista antes de intentarlo de nuevo.',
        );
      }
      throw error;
    }
  }

  private audit(
    transaction: Prisma.TransactionClient,
    storeId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
    entityType: string,
    entityId: string,
    event: {
      action: string;
      metadata: Prisma.InputJsonObject;
      reason?: string;
    },
  ) {
    return transaction.auditLog.create({
      data: {
        actorUserId: actor.userId,
        entityType,
        entityId,
        action: event.action,
        reason: event.reason,
        channel: actor.roles.includes('SUPER_ADMIN')
          ? 'ADMIN_PANEL'
          : 'STORE_PANEL',
        metadata: {
          ...event.metadata,
          storeId,
          ipAddress: context.ipAddress ?? 'unknown',
        },
      },
    });
  }

  createProduct(
    storeId: string,
    input: CreateStoreProductDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    return this.write(storeId, actor, 'products', async (transaction) => {
      const types: Record<string, string[]> = PRODUCT_TYPES;
      if (!types[input.category]?.includes(input.garmentType))
        throw new BadRequestException(
          'El tipo de prenda no corresponde a la categoria.',
        );
      if (['inferior', 'vestido'].includes(input.category) && !input.length)
        throw new BadRequestException(
          'El largo es obligatorio para esta categoria.',
        );
      if (
        (input.wholesalePriceInCents != null) !==
        (input.wholesaleMinimum != null)
      )
        throw new BadRequestException(
          'Completa el precio y la cantidad minima por mayor.',
        );
      if (
        input.wholesalePriceInCents != null &&
        input.wholesalePriceInCents > input.unitPriceInCents
      )
        throw new BadRequestException(
          'El precio por mayor no puede superar el precio unitario.',
        );
      const variants = input.variants.map((variant) => ({
        ...variant,
        sizeLabel: variant.sizeLabel.trim(),
        sizeNormalized: this.normalizeSize(variant.sizeLabel),
      }));
      if (
        new Set(
          variants.map(
            (variant) => `${variant.sizeNormalized}:${variant.color}`,
          ),
        ).size !== variants.length
      )
        throw new BadRequestException(
          'No se pueden repetir combinaciones de talla y color.',
        );
      if (!variants.some((variant) => variant.color === input.mainColor))
        throw new BadRequestException(
          'El color principal debe aparecer en una variante.',
        );
      const product = await transaction.product.create({
        data: {
          storeId,
          name: input.name.trim(),
          description: input.description.trim(),
          category: input.category,
          garmentType: input.garmentType,
          unitPriceInCents: input.unitPriceInCents,
          wholesalePriceInCents: input.wholesalePriceInCents,
          wholesaleMinimum: input.wholesaleMinimum,
          status: 'UNDER_REVIEW',
          attributes: {
            genero: input.gender,
            color_principal: input.mainColor,
            es_neutro: ['negro', 'blanco', 'beige', 'gris', 'navy'].includes(
              input.mainColor,
            ),
            patron: input.pattern,
            fit: input.fit,
            ...(input.length ? { largo: input.length } : {}),
          },
          productAttributes: {
            create: input.imageUrls.map((value, position) => ({
              code: 'image_url',
              value,
              position,
            })),
          },
          variants: {
            create: variants.map((variant) => ({
              sku: `G-${randomUUID()}`,
              sizeLabel: variant.sizeLabel,
              sizeNormalized: variant.sizeNormalized,
              color: variant.color,
              inventory: { create: { quantity: variant.quantity } },
              stockMovements: {
                create: {
                  actorUserId: actor.userId,
                  type: 'INITIAL',
                  quantity: variant.quantity,
                  balanceAfter: variant.quantity,
                  reason: 'Registro de producto',
                },
              },
            })),
          },
        },
        select: { id: true, name: true, status: true },
      });
      await this.audit(
        transaction,
        storeId,
        actor,
        context,
        'product',
        product.id,
        { action: 'PRODUCT_CREATED', metadata: { variants: variants.length } },
      );
      return product;
    });
  }

  private normalizeSize(value: string) {
    const normalized = value
      .trim()
      .normalize('NFKD')
      .replaceAll(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replaceAll(/\s+/g, ' ');
    return ['UNICA', 'TALLA UNICA', 'ONE SIZE', 'OS'].includes(normalized)
      ? 'UNICA'
      : normalized;
  }

  private async reserved(
    transaction: Prisma.TransactionClient,
    variantId: string,
  ) {
    const result = await transaction.stockHold.aggregate({
      where: {
        variantId,
        OR: [
          { status: 'FIRM' },
          {
            status: 'LIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        ],
      },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? 0;
  }

  adjustInventory(
    storeId: string,
    variantId: string,
    input: AdjustStoreInventoryDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    return this.write(storeId, actor, 'inventory', async (transaction) => {
      const variant = await transaction.variant.findFirst({
        where: {
          id: variantId,
          active: true,
          product: { storeId, deletedAt: null },
        },
        include: { inventory: true },
      });
      if (!variant)
        throw new NotFoundException('La variante no pertenece a esta tienda.');
      const previous = variant.inventory?.quantity ?? null;
      if (previous !== input.expectedQuantity)
        throw new ConflictException(
          'El stock cambio. Actualiza el inventario y vuelve a intentarlo.',
        );
      if (input.quantity < (await this.reserved(transaction, variantId)))
        throw new ConflictException(
          'El stock no puede ser menor que las unidades reservadas.',
        );
      const inventory = await transaction.inventory.upsert({
        where: { variantId },
        create: { variantId, quantity: input.quantity },
        update: { quantity: input.quantity, stockUpdatedAt: new Date() },
      });
      await transaction.stockMovement.create({
        data: {
          variantId,
          actorUserId: actor.userId,
          type: previous === null ? 'INITIAL' : 'ADJUSTMENT',
          quantity: input.quantity - (previous ?? 0),
          balanceAfter: input.quantity,
          reason: input.reason.trim(),
        },
      });
      await this.audit(
        transaction,
        storeId,
        actor,
        context,
        'inventory',
        inventory.id,
        {
          action: 'INVENTORY_ADJUSTED',
          metadata: { previous, quantity: input.quantity, variantId },
          reason: input.reason.trim(),
        },
      );
      return { variantId, quantity: inventory.quantity };
    });
  }

  async variants(
    storeId: string,
    actor: AuthenticatedUser,
    search = '',
    page = 1,
    forOrder = false,
  ) {
    await this.authorize(
      this.prisma,
      storeId,
      actor,
      forOrder ? 'orders' : 'inventory',
    );
    const where: Prisma.VariantWhereInput = {
      active: true,
      product: {
        storeId,
        deletedAt: null,
        ...(forOrder ? { status: 'PUBLISHED' } : {}),
      },
      OR: [
        { sku: { contains: search, mode: 'insensitive' } },
        { product: { name: { contains: search, mode: 'insensitive' } } },
      ],
    };
    const [variants, total] = await Promise.all([
      this.prisma.variant.findMany({
        where,
        take: 20,
        skip: (page - 1) * 20,
        orderBy: [{ product: { name: 'asc' } }, { sku: 'asc' }],
        select: {
          id: true,
          sku: true,
          sizeLabel: true,
          color: true,
          inventory: { select: { quantity: true } },
          product: { select: { name: true, unitPriceInCents: true } },
        },
      }),
      this.prisma.variant.count({ where }),
    ]);
    const data = await Promise.all(
      variants.map(async ({ product, inventory, ...variant }) => ({
        ...variant,
        productName: product.name,
        unitPriceInCents: product.unitPriceInCents,
        quantity: inventory?.quantity ?? null,
        available: inventory
          ? Math.max(
              0,
              inventory.quantity -
                (await this.reserved(this.prisma, variant.id)),
            )
          : null,
      })),
    );
    return { data, total, page, pages: Math.ceil(total / 20) };
  }

  createOrder(
    storeId: string,
    input: CreateStoreOrderDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    return this.write(storeId, actor, 'orders', async (transaction) => {
      const store = await transaction.store.findUniqueOrThrow({
        where: { id: storeId },
        select: { status: true },
      });
      if (store.status !== 'ACTIVE')
        throw new BadRequestException(
          'La tienda debe estar activa para registrar ordenes.',
        );
      if (input.zoneType === 'LIMA' && !input.district?.trim())
        throw new BadRequestException('El distrito es obligatorio para Lima.');
      if (input.zoneType === 'AGENCY' && !input.agency?.trim())
        throw new BadRequestException(
          'La agencia es obligatoria para este destino.',
        );
      if (
        new Set(input.items.map((item) => item.variantId)).size !==
        input.items.length
      )
        throw new BadRequestException(
          'No se pueden repetir variantes en la orden.',
        );
      const items: Prisma.OrderItemCreateWithoutStoreOrderInput[] = [];
      for (const item of input.items) {
        const variant = await transaction.variant.findFirst({
          where: {
            id: item.variantId,
            active: true,
            product: { storeId, deletedAt: null, status: 'PUBLISHED' },
          },
          include: { product: true, inventory: true },
        });
        if (!variant)
          throw new BadRequestException(
            'Una variante no esta publicada o no pertenece a esta tienda.',
          );
        if (
          !variant.inventory ||
          variant.inventory.quantity -
            (await this.reserved(transaction, variant.id)) <
            item.quantity
        )
          throw new ConflictException(
            'Stock disponible insuficiente. Actualiza las cantidades.',
          );
        items.push({
          variant: { connect: { id: variant.id } },
          productName: variant.product.name,
          sku: variant.sku,
          sizeLabel: variant.sizeLabel,
          color: variant.color,
          quantity: item.quantity,
          unitPriceInCents: variant.product.unitPriceInCents,
          totalInCents: variant.product.unitPriceInCents * item.quantity,
        });
      }
      const subtotalInCents = items.reduce(
        (total, item) => total + item.totalInCents,
        0,
      );
      const totalInCents = subtotalInCents + input.shippingInCents;
      if (
        !Number.isSafeInteger(totalInCents) ||
        totalInCents > 2147483647 ||
        subtotalInCents <= 0
      )
        throw new BadRequestException(
          'El importe total supera el limite permitido.',
        );
      const customer = await transaction.customer.create({
        data: {
          fullName: input.customerName.trim(),
          phone: input.customerPhone,
          email: input.customerEmail,
          addresses: {
            create: {
              recipientName: input.recipientName.trim(),
              recipientPhone: input.recipientPhone,
              zoneType: input.zoneType,
              city: input.city.trim(),
              district: input.district?.trim(),
              agency: input.agency?.trim(),
              line1: input.line1.trim(),
              reference: input.reference?.trim(),
            },
          },
        },
        select: { id: true, addresses: { select: { id: true } } },
      });
      const order = await transaction.order.create({
        data: {
          orderNumber: `G-${randomUUID().replaceAll('-', '').slice(0, 28)}`,
          customerId: customer.id,
          shippingAddressId: customer.addresses[0].id,
          subtotalInCents,
          shippingInCents: input.shippingInCents,
          totalInCents,
          status: 'PENDING_PAYMENT',
          placedAt: new Date(),
          storeOrders: {
            create: { storeId, subtotalInCents, items: { create: items } },
          },
        },
        include: { storeOrders: { include: { items: true } } },
      });
      const setting = await transaction.setting.findUnique({
        where: { key: 'stock_hold_ttl_minutes' },
        select: { value: true },
      });
      const configuredTtl = Number(setting?.value ?? 15);
      const ttl =
        Number.isFinite(configuredTtl) &&
        configuredTtl > 0 &&
        configuredTtl <= 1440
          ? configuredTtl
          : 15;
      const expiresAt = new Date(Date.now() + ttl * 60000);
      await transaction.stockHold.createMany({
        data: order.storeOrders[0].items.map((item) => ({
          variantId: item.variantId,
          orderId: order.id,
          orderItemId: item.id,
          quantity: item.quantity,
          status: 'LIVE',
          expiresAt,
        })),
      });
      await this.audit(
        transaction,
        storeId,
        actor,
        context,
        'order',
        order.id,
        {
          action: 'ORDER_CREATED',
          metadata: { totalInCents, expiresAt: expiresAt.toISOString() },
        },
      );
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        totalInCents,
        stockReservedUntil: expiresAt,
      };
    });
  }

  async shipmentOrders(
    storeId: string,
    actor: AuthenticatedUser,
    search = '',
    page = 1,
  ) {
    await this.authorize(this.prisma, storeId, actor, 'shipments');
    const where: Prisma.OrderWhereInput = {
      shipment: null,
      status: { notIn: ['CANCELLED', 'CLOSED', 'DELIVERED'] },
      orderNumber: { contains: search, mode: 'insensitive' },
      storeOrders: { some: { storeId }, every: { storeId } },
    };
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * 20,
        take: 20,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          shippingInCents: true,
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, total, page, pages: Math.ceil(total / 20) };
  }

  createShipment(
    storeId: string,
    input: CreateStoreShipmentDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    return this.write(storeId, actor, 'shipments', async (transaction) => {
      const order = await transaction.order.findFirst({
        where: {
          id: input.orderId,
          storeOrders: { some: { storeId }, every: { storeId } },
        },
        include: { shipment: true },
      });
      if (!order)
        throw new NotFoundException(
          'La orden no pertenece exclusivamente a esta tienda.',
        );
      if (order.shipment)
        throw new ConflictException('Esta orden ya tiene un envio registrado.');
      if (['CANCELLED', 'CLOSED', 'DELIVERED'].includes(order.status))
        throw new BadRequestException(
          'El estado de la orden no permite crear un envio.',
        );
      const pickup = input.pickupScheduledAt
        ? new Date(input.pickupScheduledAt)
        : undefined;
      if (pickup && pickup.getTime() <= Date.now())
        throw new BadRequestException('La fecha de recojo debe ser futura.');
      const shipment = await transaction.shipment.create({
        data: {
          orderId: order.id,
          method: input.method.trim(),
          provider: input.provider.trim(),
          trackingCode: input.trackingCode?.trim(),
          pickupScheduledAt: pickup,
          shippingRateInCents: order.shippingInCents,
          status: 'PENDING',
        },
        select: { id: true, status: true },
      });
      await this.audit(
        transaction,
        storeId,
        actor,
        context,
        'shipment',
        shipment.id,
        { action: 'SHIPMENT_CREATED', metadata: { orderId: order.id } },
      );
      return shipment;
    });
  }
}
