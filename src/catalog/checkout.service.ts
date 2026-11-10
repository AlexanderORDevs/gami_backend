import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CheckoutOrderDto, CheckoutQuoteDto } from './checkout.dto.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CustomersService } from '../customers/customers.service.js';
import { resolveShippingRate } from './shipping-rate.js';

const AGENCY_COMMISSION_RATE_KEY = 'commission_rate_basis_points_agency';

export function agencyCommissionSnapshot(
  subtotalInCents: number,
  rateBasisPoints: number | null,
) {
  if (rateBasisPoints === null)
    return { commissionInCents: null, netAmountInCents: null };
  const commissionInCents = Math.round(
    (subtotalInCents * rateBasisPoints) / 10000,
  );
  return {
    commissionInCents,
    netAmountInCents: subtotalInCents - commissionInCents,
  };
}

const variantSelect = {
  id: true,
  sku: true,
  sizeLabel: true,
  color: true,
  inventory: { select: { quantity: true } },
  product: {
    select: {
      id: true,
      name: true,
      unitPriceInCents: true,
      storeId: true,
      store: { select: { displayName: true } },
    },
  },
} satisfies Prisma.VariantSelect;
type CheckoutVariant = Prisma.VariantGetPayload<{
  select: typeof variantSelect;
}>;
type CheckoutLine = {
  variantId: string;
  productId: string;
  productName: string;
  storeId: string;
  storeName: string;
  sku: string;
  size: string;
  color: string;
  quantity: number;
  unitPriceInCents: number;
  totalInCents: number;
};
export type CheckoutReceipt = {
  orderNumber: string;
  status: 'PENDING_PAYMENT';
  subtotalInCents: number;
  shippingInCents: number;
  totalInCents: number;
  stockReservedUntil: string;
};

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
  ) {}

  async destinations() {
    const now = new Date();
    const rates = await this.prisma.shippingRate.findMany({
      where: {
        active: true,
        currency: 'PEN',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: [{ zoneType: 'asc' }, { district: 'asc' }],
      select: { zoneType: true, district: true },
      distinct: ['zoneType', 'district'],
    });
    return { destinations: rates };
  }

  private async lines(
    transaction: Prisma.TransactionClient,
    input: CheckoutQuoteDto,
    lock: boolean,
  ): Promise<CheckoutLine[]> {
    if (
      new Set(input.items.map((item) => item.variantId)).size !==
      input.items.length
    )
      throw new BadRequestException(
        'No repitas la misma variante en el carrito.',
      );
    const variants = await transaction.variant.findMany({
      where: {
        id: { in: input.items.map((item) => item.variantId) },
        active: true,
        product: {
          status: 'PUBLISHED',
          deletedAt: null,
          store: { status: 'ACTIVE', deletedAt: null },
        },
      },
      select: variantSelect,
    });
    if (variants.length !== input.items.length)
      throw new ConflictException(
        'Una prenda ya no está disponible. Actualiza el carrito.',
      );
    if (lock) {
      for (const storeId of [
        ...new Set(variants.map((variant) => variant.product.storeId)),
      ].sort((left, right) => left.localeCompare(right))) {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:store-operations:' + storeId}))`;
      }
      const ids = Prisma.join(
        variants.map((variant) => Prisma.sql`${variant.id}::uuid`),
      );
      await transaction.$queryRaw`SELECT id FROM inventory WHERE variant_id IN (${ids}) ORDER BY variant_id FOR UPDATE`;
      return this.lines(transaction, input, false);
    }
    const result: CheckoutLine[] = [];
    for (const item of input.items) {
      const variant = variants.find(
        (candidate) => candidate.id === item.variantId,
      )!;
      result.push(await this.line(transaction, variant, item.quantity));
    }
    return result;
  }

  private async line(
    transaction: Prisma.TransactionClient,
    variant: CheckoutVariant,
    quantity: number,
  ): Promise<CheckoutLine> {
    const now = new Date();
    const inventory = await transaction.inventory.findUnique({
      where: { variantId: variant.id },
      select: { quantity: true, needsReview: true },
    });
    const reserved = await transaction.stockHold.aggregate({
      where: {
        variantId: variant.id,
        OR: [
          { status: 'FIRM' },
          {
            status: 'LIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        ],
      },
      _sum: { quantity: true },
    });
    if (
      !inventory ||
      inventory.needsReview ||
      inventory.quantity - (reserved._sum.quantity ?? 0) < quantity
    )
      throw new ConflictException(
        'Stock insuficiente o por confirmar. Revisa las cantidades del carrito.',
      );
    if (variant.product.unitPriceInCents <= 0)
      throw new ConflictException('Una prenda no tiene un precio válido.');
    return {
      variantId: variant.id,
      productId: variant.product.id,
      productName: variant.product.name,
      storeId: variant.product.storeId,
      storeName: variant.product.store.displayName,
      sku: variant.sku,
      size: variant.sizeLabel,
      color: variant.color,
      quantity,
      unitPriceInCents: variant.product.unitPriceInCents,
      totalInCents: variant.product.unitPriceInCents * quantity,
    };
  }

  private async calculate(
    transaction: Prisma.TransactionClient,
    input: CheckoutQuoteDto,
    lock = false,
  ) {
    if (input.zoneType === 'LIMA' && !input.district?.trim())
      throw new BadRequestException('Selecciona el distrito de entrega.');
    const lines = await this.lines(transaction, input, lock);
    const units = lines.reduce((total, item) => total + item.quantity, 0);
    const shippingInCents = await resolveShippingRate(
      transaction,
      input.zoneType,
      input.district,
      units,
    );
    const subtotalInCents = lines.reduce(
      (total, item) => total + item.totalInCents,
      0,
    );
    const totalInCents = subtotalInCents + shippingInCents;
    if (!Number.isSafeInteger(totalInCents) || totalInCents > 2147483647)
      throw new BadRequestException('El total supera el límite permitido.');
    return {
      lines,
      subtotalInCents,
      shippingInCents,
      totalInCents,
      currency: 'PEN' as const,
    };
  }

  quote(input: CheckoutQuoteDto) {
    return this.prisma.$transaction(
      (transaction) => this.calculate(transaction, input),
      { timeout: 20000 },
    );
  }

  create(input: CheckoutOrderDto, actor: AuthenticatedUser) {
    return this.prisma.$transaction(
      async (transaction) => {
        const customerId = await this.customers.requireCustomer(
          actor,
          transaction,
        );
        const requestKey = `${actor.userId}:${input.requestId}`;
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:checkout:' + requestKey}))`;
        const inputHash = createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex');
        const previous = await transaction.integrationEvent.findUnique({
          where: {
            provider_externalEventId: {
              provider: 'PUBLIC_CHECKOUT',
              externalEventId: requestKey,
            },
          },
          select: { payload: true },
        });
        if (previous) {
          const payload = previous.payload as {
            inputHash: string;
            receipt: CheckoutReceipt;
          };
          if (payload.inputHash !== inputHash)
            throw new ConflictException(
              'La solicitud ya fue utilizada. Inicia una nueva confirmación.',
            );
          return payload.receipt;
        }
        if (input.zoneType === 'AGENCY' && !input.agency?.trim())
          throw new BadRequestException('Indica la agencia de destino.');
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:customer-cart:' + customerId}))`;
        const cart = await transaction.customerCartItem.findMany({
          where: { customerId },
          select: { variantId: true, quantity: true },
        });
        if (
          cart.length !== input.items.length ||
          input.items.some(
            (item) =>
              !cart.some(
                (row) =>
                  row.variantId === item.variantId &&
                  row.quantity === item.quantity,
              ),
          )
        )
          throw new ConflictException(
            'Tu carrito cambió. Actualízalo antes de confirmar.',
          );
        const quote = await this.calculate(transaction, input, true);
        if (
          quote.subtotalInCents !== input.expectedSubtotalInCents ||
          quote.shippingInCents !== input.expectedShippingInCents
        )
          throw new ConflictException(
            'El precio o la tarifa cambió. Actualiza el resumen antes de confirmar.',
          );
        const commissionSetting = await transaction.setting.findUnique({
          where: { key: AGENCY_COMMISSION_RATE_KEY },
          select: { value: true },
        });
        const commissionRateBasisPoints =
          commissionSetting === null
            ? null
            : typeof commissionSetting.value === 'number' &&
                Number.isInteger(commissionSetting.value) &&
                commissionSetting.value >= 0 &&
                commissionSetting.value <= 10000
              ? commissionSetting.value
              : null;
        if (commissionSetting !== null && commissionRateBasisPoints === null)
          throw new ConflictException(
            'La tasa de comisión configurada no es válida. Contacta a Gami.',
          );
        const address = await transaction.address.create({
          data: {
            customerId,
            recipientName: input.recipientName.trim(),
            recipientPhone: input.recipientPhone,
            zoneType: input.zoneType,
            city: input.city.trim(),
            district: input.district?.trim(),
            agency: input.agency?.trim(),
            line1: input.line1.trim(),
            reference: input.reference?.trim(),
          },
          select: { id: true },
        });
        const storeIds = [...new Set(quote.lines.map((item) => item.storeId))];
        const order = await transaction.order.create({
          data: {
            orderNumber: `G-${randomUUID().replaceAll('-', '').slice(0, 28)}`,
            customerId,
            shippingAddressId: address.id,
            subtotalInCents: quote.subtotalInCents,
            shippingInCents: quote.shippingInCents,
            totalInCents: quote.totalInCents,
            status: 'PENDING_PAYMENT',
            placedAt: new Date(),
            storeOrders: {
              create: storeIds.map((storeId) => {
                const storeLines = quote.lines.filter(
                  (item) => item.storeId === storeId,
                );
                const subtotalInCents = storeLines.reduce(
                  (total, item) => total + item.totalInCents,
                  0,
                );
                const commission = agencyCommissionSnapshot(
                  subtotalInCents,
                  commissionRateBasisPoints,
                );
                return {
                  storeId,
                  commercialModel: 'AGENCY' as const,
                  commissionRateBasisPoints,
                  subtotalInCents,
                  commissionInCents: commission.commissionInCents,
                  netAmountInCents: commission.netAmountInCents,
                  items: {
                    create: storeLines.map((item) => ({
                      variantId: item.variantId,
                      productName: item.productName,
                      sku: item.sku,
                      sizeLabel: item.size,
                      color: item.color,
                      quantity: item.quantity,
                      unitPriceInCents: item.unitPriceInCents,
                      totalInCents: item.totalInCents,
                    })),
                  },
                };
              }),
            },
          },
          select: {
            id: true,
            orderNumber: true,
            storeOrders: {
              select: {
                items: {
                  select: { id: true, variantId: true, quantity: true },
                },
              },
            },
          },
        });
        const setting = await transaction.setting.findUnique({
          where: { key: 'stock_hold_ttl_minutes' },
          select: { value: true },
        });
        const configured = Number(setting?.value ?? 15);
        const minutes =
          Number.isFinite(configured) && configured > 0 && configured <= 1440
            ? configured
            : 15;
        const expiresAt = new Date(Date.now() + minutes * 60000);
        await transaction.stockHold.createMany({
          data: order.storeOrders.flatMap((storeOrder) =>
            storeOrder.items.map((item) => ({
              variantId: item.variantId,
              orderItemId: item.id,
              orderId: order.id,
              quantity: item.quantity,
              status: 'LIVE' as const,
              expiresAt,
            })),
          ),
        });
        const receipt: CheckoutReceipt = {
          orderNumber: order.orderNumber,
          status: 'PENDING_PAYMENT',
          subtotalInCents: quote.subtotalInCents,
          shippingInCents: quote.shippingInCents,
          totalInCents: quote.totalInCents,
          stockReservedUntil: expiresAt.toISOString(),
        };
        await transaction.integrationEvent.create({
          data: {
            provider: 'PUBLIC_CHECKOUT',
            externalEventId: requestKey,
            eventType: 'ORDER_CREATED',
            status: 'PROCESSED',
            processedAt: new Date(),
            payload: { inputHash, receipt },
          },
        });
        await transaction.auditLog.create({
          data: {
            actorUserId: actor.userId,
            entityType: 'order',
            entityId: order.id,
            action: 'CHECKOUT_ORDER_CREATED',
            channel: 'CUSTOMER_APP',
            metadata: {
              totalInCents: quote.totalInCents,
              storeCount: storeIds.length,
            },
          },
        });
        await transaction.customerCartItem.deleteMany({
          where: { customerId },
        });
        return receipt;
      },
      { timeout: 30000 },
    );
  }
}
