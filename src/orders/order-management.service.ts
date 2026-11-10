import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { CustomersService } from '../customers/customers.service.js';
import {
  StoreAccessService,
  STORE_WRITE_PERMISSIONS,
} from '../stores/store-access.service.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import type {
  ConfirmStoreOrderDto,
  ReportOrderIncidentDto,
  ReviewOrderIncidentDto,
} from './order-management.dto.js';

const workflowInclude = {
  order: { include: { payment: true } },
  items: {
    orderBy: { id: 'asc' },
    include: { stockHolds: { where: { status: 'FIRM' } } },
  },
} as const satisfies Prisma.StoreOrderInclude;
type ManagedStoreOrder = Prisma.StoreOrderGetPayload<{
  include: typeof workflowInclude;
}>;
type PaymentEvidence = {
  status: string;
  amountInCents: number;
  currency: string;
  capturedAt: Date | null;
} | null;
export function hasVerifiedPayment(order: {
  totalInCents: number;
  currency: string;
  payment: PaymentEvidence;
}) {
  return (
    order.totalInCents > 0 &&
    order.payment?.status === 'CAPTURED' &&
    order.payment.amountInCents === order.totalInCents &&
    order.payment.currency === order.currency &&
    order.payment.capturedAt !== null
  );
}
function versionCheck(actual: Date, expected: string) {
  if (actual.getTime() !== new Date(expected).getTime())
    throw new ConflictException(
      'La orden cambió. Actualiza el detalle antes de continuar.',
    );
}
function isPending(status: string) {
  return ['PENDING_CONFIRMATION', 'PRE_CONFIRMED'].includes(status);
}
function isTerminal(status: string) {
  return ['CANCELLED', 'CLOSED', 'DELIVERED'].includes(status);
}

@Injectable()
export class OrderManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly access: StoreAccessService,
  ) {}

  private async scope(actor: AuthenticatedUser) {
    if (actor.roles.includes('SUPER_ADMIN'))
      return {
        kind: 'admin' as const,
        customerId: undefined,
        storeIds: undefined,
        writable: [] as string[],
      };
    if (actor.roles.length === 1 && actor.roles[0] === 'CUSTOMER')
      return {
        kind: 'customer' as const,
        customerId: await this.customers.requireCustomer(actor),
        storeIds: undefined,
        writable: [] as string[],
      };
    const stores = (await this.access.list(actor)).filter((store) =>
      store.permissions.includes('orders'),
    );
    return {
      kind: 'store' as const,
      customerId: undefined,
      storeIds: stores.map((store) => store.id),
      writable: stores
        .filter((store) => store.writePermissions.includes('orders'))
        .map((store) => store.id),
    };
  }

  async detail(orderNumber: string, actor: AuthenticatedUser) {
    const scope = await this.scope(actor);
    const where: Prisma.OrderWhereInput = {
      orderNumber,
      ...(scope.kind === 'customer' ? { customerId: scope.customerId } : {}),
      ...(scope.kind === 'store'
        ? { storeOrders: { some: { storeId: { in: scope.storeIds } } } }
        : {}),
    };
    const order = await this.prisma.order.findFirst({
      where,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        currency: true,
        subtotalInCents: true,
        shippingInCents: true,
        discountInCents: true,
        totalInCents: true,
        createdAt: true,
        customer:
          scope.kind === 'store'
            ? false
            : { select: { fullName: true, phone: true, email: true } },
        shippingAddress:
          scope.kind === 'store'
            ? false
            : {
                select: {
                  recipientName: true,
                  recipientPhone: true,
                  zoneType: true,
                  city: true,
                  district: true,
                  agency: true,
                  line1: true,
                  reference: true,
                },
              },
        payment: {
          select: {
            status: true,
            amountInCents: true,
            currency: true,
            capturedAt: true,
          },
        },
        storeOrders: {
          where:
            scope.kind === 'store' ? { storeId: { in: scope.storeIds } } : {},
          orderBy: { id: 'asc' },
          select: {
            id: true,
            storeId: true,
            status: true,
            subtotalInCents: true,
            updatedAt: true,
            confirmedAt: true,
            rejectedAt: true,
            store: { select: { displayName: true } },
            items: {
              orderBy: { id: 'asc' },
              select: {
                id: true,
                productName: true,
                sizeLabel: true,
                color: true,
                quantity: true,
                confirmedQuantity: true,
                unitPriceInCents: true,
                totalInCents: true,
                stockHolds: {
                  where: { status: 'FIRM' },
                  select: { quantity: true },
                },
              },
            },
            fulfillmentExceptions: {
              orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
              select: {
                id: true,
                type: true,
                description: true,
                affectedItems: true,
                createdAt: true,
                updatedAt: true,
                reviewedAt: true,
                reviewNote: scope.kind !== 'customer',
                resolution: true,
                resolvedAt: true,
              },
            },
          },
        },
      },
    });
    if (!order)
      throw new NotFoundException('No se encontró esta orden para tu cuenta.');
    const paymentVerified = hasVerifiedPayment(order);
    const events = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          ...(scope.kind === 'store'
            ? []
            : [{ entityType: 'order', entityId: order.id }]),
          {
            entityType: 'store_order',
            entityId: { in: order.storeOrders.map((row) => row.id) },
          },
          {
            entityType: 'fulfillment_exception',
            entityId: {
              in: order.storeOrders.flatMap((row) =>
                row.fulfillmentExceptions.map((incident) => incident.id),
              ),
            },
          },
        ],
        action: {
          in: [
            'ORDER_CREATED',
            'CHECKOUT_ORDER_CREATED',
            'STORE_ORDER_CONFIRMED',
            'ORDER_INCIDENT_REPORTED',
            'ORDER_INCIDENT_REVIEWED',
          ],
        },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        action: true,
        occurredAt: true,
        reason: scope.kind !== 'customer',
        channel: true,
      },
    });
    const suborders = order.storeOrders.map((row) => {
      const canWrite =
        scope.kind === 'admin' || scope.writable.includes(row.storeId);
      const firmStock =
        row.items.length > 0 &&
        row.items.every(
          (item) =>
            item.stockHolds.reduce(
              (total, hold) => total + hold.quantity,
              0,
            ) === item.quantity,
        );
      let confirmationBlock: string | null = null;
      if (!canWrite)
        confirmationBlock = 'Tu cuenta no puede confirmar esta suborden.';
      else if (!isPending(row.status))
        confirmationBlock =
          'Esta suborden ya tiene una decisión o no admite confirmación.';
      else if (
        !paymentVerified ||
        !['PAID', 'PARTIALLY_CONFIRMED'].includes(order.status)
      )
        confirmationBlock =
          'La confirmación requiere pago verificado. Esta etapa todavía no verifica pagos.';
      else if (!firmStock)
        confirmationBlock =
          'Faltan reservas firmes completas. Administración debe revisar la orden.';
      return {
        id: row.id,
        storeId: row.storeId,
        storeName: row.store.displayName,
        status: row.status,
        subtotalInCents: row.subtotalInCents,
        updatedAt: row.updatedAt,
        confirmedAt: row.confirmedAt,
        rejectedAt: row.rejectedAt,
        canConfirm: confirmationBlock === null,
        confirmationBlock,
        canReportIncident:
          canWrite &&
          !isTerminal(order.status) &&
          !['CANCELLED', 'DELIVERED'].includes(row.status),
        items: row.items.map(({ stockHolds: _holds, ...item }) => item),
        incidents: row.fulfillmentExceptions.map((incident) => ({
          ...incident,
          reviewNote: scope.kind === 'customer' ? null : incident.reviewNote,
        })),
      };
    });
    const subtotal =
      scope.kind === 'store'
        ? suborders.reduce((total, row) => total + row.subtotalInCents, 0)
        : order.subtotalInCents;
    return {
      orderNumber: order.orderNumber,
      scope: scope.kind,
      status: scope.kind === 'store' ? null : order.status,
      currency: order.currency,
      createdAt: order.createdAt,
      subtotalInCents: subtotal,
      shippingInCents: scope.kind === 'store' ? null : order.shippingInCents,
      discountInCents: scope.kind === 'store' ? null : order.discountInCents,
      totalInCents: scope.kind === 'store' ? subtotal : order.totalInCents,
      paymentStatus: order.payment?.status ?? null,
      paymentVerified,
      customer: scope.kind === 'store' ? null : order.customer,
      shippingAddress: scope.kind === 'store' ? null : order.shippingAddress,
      suborders,
      timeline: events.reverse().map((event) => ({
        action: event.action,
        occurredAt: event.occurredAt,
        reason: scope.kind === 'customer' ? null : event.reason,
        channel: event.channel,
      })),
      canReviewIncidents: scope.kind === 'admin',
    };
  }

  private async writable(
    storeId: string,
    actor: AuthenticatedUser,
    transaction: Prisma.TransactionClient,
  ) {
    const role = await this.access.require(
      storeId,
      actor,
      'orders',
      transaction,
    );
    if (!STORE_WRITE_PERMISSIONS[role].includes('orders'))
      throw new ForbiddenException(
        'No tienes permiso para modificar las órdenes de esta tienda.',
      );
  }

  private async change<T>(
    storeOrderId: string,
    actor: AuthenticatedUser,
    operation: (
      transaction: Prisma.TransactionClient,
      row: ManagedStoreOrder,
    ) => Promise<T>,
  ) {
    return this.prisma.$transaction(
      async (transaction) => {
        const target = await transaction.storeOrder.findUnique({
          where: { id: storeOrderId },
          select: { storeId: true, orderId: true },
        });
        if (!target) throw new NotFoundException('No se encontró la suborden.');
        await this.writable(target.storeId, actor, transaction);
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:order-management:' + target.orderId}))`;
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:store-members:' + target.storeId}))`;
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:store-operations:' + target.storeId}))`;
        await this.writable(target.storeId, actor, transaction);
        const row = await transaction.storeOrder.findUniqueOrThrow({
          where: { id: storeOrderId },
          include: workflowInclude,
        });
        if (isTerminal(row.order.status))
          throw new ConflictException(
            'El estado de la orden no admite esta operación.',
          );
        return operation(transaction, row);
      },
      { timeout: 30000 },
    );
  }

  private audit(
    transaction: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    event: {
      entityType: string;
      entityId: string;
      action: string;
      reason: string;
      metadata?: Prisma.InputJsonObject;
    },
  ) {
    return transaction.auditLog.create({
      data: {
        actorUserId: actor.userId,
        channel: actor.roles.includes('SUPER_ADMIN')
          ? 'ADMIN_PANEL'
          : 'STORE_PANEL',
        ...event,
      },
    });
  }

  confirm(
    storeOrderId: string,
    input: ConfirmStoreOrderDto,
    actor: AuthenticatedUser,
  ) {
    return this.change(storeOrderId, actor, async (transaction, row) => {
      versionCheck(row.updatedAt, input.expectedUpdatedAt);
      if (
        !isPending(row.status) ||
        row.items.some((item) => item.confirmedQuantity !== null)
      )
        throw new ConflictException(
          'La suborden ya fue confirmada o rechazada.',
        );
      if (
        !hasVerifiedPayment(row.order) ||
        !['PAID', 'PARTIALLY_CONFIRMED'].includes(row.order.status)
      )
        throw new ConflictException(
          'Se requiere pago verificado antes de confirmar prendas.',
        );
      if (
        input.items.length !== row.items.length ||
        new Set(input.items.map((item) => item.orderItemId)).size !==
          input.items.length ||
        input.items.some(
          (item) =>
            !row.items.some(
              (record) =>
                record.id === item.orderItemId &&
                item.confirmedQuantity <= record.quantity,
            ),
        )
      )
        throw new BadRequestException(
          'Confirma cada prenda de esta suborden con una cantidad válida.',
        );
      const missing: {
        orderItemId: string;
        orderedQuantity: number;
        confirmedQuantity: number;
        missingQuantity: number;
      }[] = [];
      let confirmedTotal = 0;
      for (const item of row.items) {
        const quantity = input.items.find(
          (record) => record.orderItemId === item.id,
        )!.confirmedQuantity;
        if (
          item.stockHolds.reduce((total, hold) => total + hold.quantity, 0) !==
          item.quantity
        )
          throw new ConflictException(
            'Las reservas firmes no coinciden con la suborden.',
          );
        if (quantity > 0) {
          const inventory = await transaction.inventory.findUnique({
            where: { variantId: item.variantId },
            select: { quantity: true, needsReview: true },
          });
          if (
            !inventory ||
            inventory.needsReview ||
            inventory.quantity < quantity
          )
            throw new ConflictException(
              'El inventario actual no permite confirmar esta cantidad. Revisa el recuento o reporta el faltante.',
            );
          const updated = await transaction.inventory.updateMany({
            where: { variantId: item.variantId, quantity: { gte: quantity } },
            data: {
              quantity: { decrement: quantity },
              stockUpdatedAt: new Date(),
            },
          });
          if (updated.count !== 1)
            throw new ConflictException(
              'El stock cambió. Actualiza el detalle.',
            );
          await transaction.stockMovement.create({
            data: {
              variantId: item.variantId,
              orderItemId: item.id,
              actorUserId: actor.userId,
              type: 'SALE',
              quantity: -quantity,
              balanceAfter: inventory.quantity - quantity,
              reason: input.reason.trim(),
            },
          });
        }
        const now = new Date();
        await transaction.stockHold.updateMany({
          where: { orderItemId: item.id, status: 'FIRM' },
          data: { status: 'RELEASED', releasedAt: now },
        });
        if (quantity > 0)
          await transaction.stockHold.create({
            data: {
              orderId: row.orderId,
              orderItemId: item.id,
              variantId: item.variantId,
              quantity,
              status: 'CONSUMED',
              firmedAt: now,
              consumedAt: now,
            },
          });
        await transaction.orderItem.update({
          where: { id: item.id },
          data: { confirmedQuantity: quantity },
        });
        confirmedTotal += quantity;
        if (quantity < item.quantity) {
          missing.push({
            orderItemId: item.id,
            orderedQuantity: item.quantity,
            confirmedQuantity: quantity,
            missingQuantity: item.quantity - quantity,
          });
          await transaction.inventory.updateMany({
            where: { variantId: item.variantId },
            data: { needsReview: true },
          });
        }
      }
      const status =
        confirmedTotal === 0
          ? 'REJECTED'
          : missing.length
            ? 'PARTIALLY_CONFIRMED'
            : 'CONFIRMED';
      await transaction.storeOrder.update({
        where: { id: row.id },
        data: {
          status,
          confirmationChannel: actor.roles.includes('SUPER_ADMIN')
            ? 'ADMIN_PANEL'
            : 'STORE_PANEL',
          confirmedById: actor.userId,
          confirmedAt: confirmedTotal ? new Date() : null,
          rejectedAt: confirmedTotal ? null : new Date(),
        },
      });
      if (missing.length) {
        const incident = await transaction.fulfillmentException.create({
          data: {
            storeOrderId: row.id,
            type: 'OUT_OF_STOCK',
            description: input.reason.trim(),
            affectedItems: missing,
          },
        });
        await this.audit(transaction, actor, {
          entityType: 'fulfillment_exception',
          entityId: incident.id,
          action: 'ORDER_INCIDENT_REPORTED',
          reason: input.reason.trim(),
          metadata: { storeOrderId: row.id, missingItems: missing.length },
        });
      }
      const siblings = await transaction.storeOrder.findMany({
        where: { orderId: row.orderId },
        select: { status: true },
      });
      const nextStatus = siblings.every((item) => item.status === 'CONFIRMED')
        ? 'CONFIRMED'
        : siblings.some((item) =>
              ['CONFIRMED', 'PARTIALLY_CONFIRMED'].includes(item.status),
            )
          ? 'PARTIALLY_CONFIRMED'
          : 'PAID';
      await transaction.order.update({
        where: { id: row.orderId },
        data: { status: nextStatus },
      });
      await this.audit(transaction, actor, {
        entityType: 'store_order',
        entityId: row.id,
        action: 'STORE_ORDER_CONFIRMED',
        reason: input.reason.trim(),
        metadata: {
          status,
          confirmedUnits: confirmedTotal,
          missingItems: missing.length,
        },
      });
      return {
        orderNumber: row.order.orderNumber,
        status,
        missingItems: missing.length,
      };
    });
  }

  report(
    storeOrderId: string,
    input: ReportOrderIncidentDto,
    actor: AuthenticatedUser,
  ) {
    return this.change(storeOrderId, actor, async (transaction, row) => {
      const key = `${actor.userId}:${input.requestId}`;
      const inputHash = createHash('sha256')
        .update(JSON.stringify({ storeOrderId, ...input }))
        .digest('hex');
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:incident:' + key}))`;
      const previous = await transaction.integrationEvent.findUnique({
        where: {
          provider_externalEventId: {
            provider: 'ORDER_INCIDENT',
            externalEventId: key,
          },
        },
        select: { payload: true },
      });
      if (previous) {
        const payload = previous.payload as {
          inputHash: string;
          incidentId: string;
        };
        if (payload.inputHash !== inputHash)
          throw new ConflictException(
            'La solicitud ya fue utilizada para otra incidencia.',
          );
        return { incidentId: payload.incidentId };
      }
      versionCheck(row.updatedAt, input.expectedUpdatedAt);
      if (['CANCELLED', 'DELIVERED'].includes(row.status))
        throw new ConflictException(
          'Esta suborden no admite incidencias en esta etapa.',
        );
      if (
        new Set(input.items.map((item) => item.orderItemId)).size !==
          input.items.length ||
        input.items.some(
          (item) =>
            !row.items.some(
              (record) =>
                record.id === item.orderItemId &&
                item.quantity <= record.quantity,
            ),
        )
      )
        throw new BadRequestException(
          'Las prendas afectadas deben pertenecer a esta suborden y tener cantidades válidas.',
        );
      const incident = await transaction.fulfillmentException.create({
        data: {
          storeOrderId,
          type: input.type,
          description: input.reason.trim(),
          affectedItems: input.items.map((item) => ({
            orderItemId: item.orderItemId,
            quantity: item.quantity,
          })),
        },
      });
      if (input.type === 'OUT_OF_STOCK')
        await transaction.inventory.updateMany({
          where: {
            variantId: {
              in: row.items
                .filter((item) =>
                  input.items.some(
                    (affected) => affected.orderItemId === item.id,
                  ),
                )
                .map((item) => item.variantId),
            },
          },
          data: { needsReview: true },
        });
      await transaction.storeOrder.update({
        where: { id: row.id },
        data: { updatedAt: new Date() },
      });
      await transaction.integrationEvent.create({
        data: {
          provider: 'ORDER_INCIDENT',
          externalEventId: key,
          eventType: 'INCIDENT_REPORTED',
          status: 'PROCESSED',
          processedAt: new Date(),
          payload: { inputHash, incidentId: incident.id },
        },
      });
      await this.audit(transaction, actor, {
        entityType: 'fulfillment_exception',
        entityId: incident.id,
        action: 'ORDER_INCIDENT_REPORTED',
        reason: input.reason.trim(),
        metadata: { storeOrderId },
      });
      return { incidentId: incident.id };
    });
  }

  async review(
    incidentId: string,
    input: ReviewOrderIncidentDto,
    actor: AuthenticatedUser,
  ) {
    if (!actor.roles.includes('SUPER_ADMIN'))
      throw new ForbiddenException(
        'Solo administración puede revisar incidencias.',
      );
    return this.prisma.$transaction(async (transaction) => {
      const initial = await transaction.fulfillmentException.findUnique({
        where: { id: incidentId },
        select: { storeOrder: { select: { orderId: true } } },
      });
      if (!initial)
        throw new NotFoundException('No se encontró la incidencia.');
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:order-management:' + initial.storeOrder.orderId}))`;
      const incident = await transaction.fulfillmentException.findUniqueOrThrow(
        { where: { id: incidentId } },
      );
      versionCheck(incident.updatedAt, input.expectedUpdatedAt);
      if (incident.resolvedAt)
        throw new ConflictException('La incidencia ya está resuelta.');
      await transaction.fulfillmentException.update({
        where: { id: incidentId },
        data: {
          reviewNote: input.note.trim(),
          reviewedAt: new Date(),
          reviewedById: actor.userId,
        },
      });
      await this.audit(transaction, actor, {
        entityType: 'fulfillment_exception',
        entityId: incidentId,
        action: 'ORDER_INCIDENT_REVIEWED',
        reason: input.note.trim().slice(0, 255),
      });
      return { reviewed: true, resolved: false };
    });
  }
}
