import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import type {
  CreateShippingRateDto,
  InformationQueryDto,
  RegisterPayoutDto,
  UpsertCalendarDayDto,
} from './admin-information.dto.js';

const PAGE_SIZE = 20;
const VISIBLE_SETTINGS = [
  'stock_hold_ttl_minutes',
  'confirmation_sla_minutes',
  'whatsapp_delivery_tolerance_minutes',
  'active_strike_limit',
  'strike_expiration_days',
  'appeal_window_days',
];

function pagination(query: InformationQueryDto) {
  return { skip: (query.page - 1) * PAGE_SIZE, take: PAGE_SIZE };
}

function result<T>(data: T[], total: number, page: number) {
  return { data, total, page, pages: Math.ceil(total / PAGE_SIZE) };
}

@Injectable()
export class AdminInformationService {
  constructor(private readonly prisma: PrismaService) {}

  async stores(query: InformationQueryDto) {
    const where: Prisma.StoreWhereInput = {
      deletedAt: null,
      ...(query.search?.trim()
        ? {
            displayName: { contains: query.search.trim(), mode: 'insensitive' },
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.store.findMany({
        where,
        ...pagination(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          displayName: true,
          legalName: true,
          status: true,
          gallery: true,
          standNumber: true,
          whatsappVerifiedAt: true,
          createdAt: true,
          _count: {
            select: {
              products: { where: { deletedAt: null } },
              members: { where: { active: true } },
            },
          },
        },
      }),
      this.prisma.store.count({ where }),
    ]);
    return result(
      data.map(({ _count, ...store }) => ({
        ...store,
        products: _count.products,
        members: _count.members,
      })),
      total,
      query.page,
    );
  }

  async products(query: InformationQueryDto) {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      store: { deletedAt: null },
      ...(query.search?.trim()
        ? { name: { contains: query.search.trim(), mode: 'insensitive' } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        ...pagination(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          category: true,
          garmentType: true,
          status: true,
          unitPriceInCents: true,
          wholesalePriceInCents: true,
          wholesaleMinimum: true,
          updatedAt: true,
          store: { select: { displayName: true } },
          _count: { select: { variants: { where: { active: true } } } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    return result(
      data.map(({ store, _count, ...product }) => ({
        ...product,
        store: store.displayName,
        variants: _count.variants,
      })),
      total,
      query.page,
    );
  }

  async orders(query: InformationQueryDto) {
    const where: Prisma.OrderWhereInput = query.search?.trim()
      ? { orderNumber: { contains: query.search.trim(), mode: 'insensitive' } }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        ...pagination(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          orderNumber: true,
          status: true,
          currency: true,
          totalInCents: true,
          subtotalInCents: true,
          shippingInCents: true,
          discountInCents: true,
          createdAt: true,
          promisedDeliveryStartAt: true,
          promisedDeliveryEndAt: true,
          _count: { select: { storeOrders: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return result(
      data.map(({ _count, ...order }) => ({
        ...order,
        stores: _count.storeOrders,
      })),
      total,
      query.page,
    );
  }

  async shipments(query: InformationQueryDto) {
    const where: Prisma.ShipmentWhereInput = query.search?.trim()
      ? {
          order: {
            orderNumber: { contains: query.search.trim(), mode: 'insensitive' },
          },
        }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        ...pagination(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          method: true,
          provider: true,
          trackingCode: true,
          pickupScheduledAt: true,
          pickedUpAt: true,
          dispatchedAt: true,
          deliveredAt: true,
          createdAt: true,
          order: { select: { orderNumber: true } },
        },
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return result(
      data.map(({ order, ...shipment }) => ({
        ...shipment,
        orderNumber: order.orderNumber,
      })),
      total,
      query.page,
    );
  }

  async payouts(query: InformationQueryDto) {
    const where: Prisma.PayoutWhereInput = query.search?.trim()
      ? {
          store: {
            displayName: { contains: query.search.trim(), mode: 'insensitive' },
          },
        }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        ...pagination(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          amountInCents: true,
          currency: true,
          isDemo: true,
          scheduledAt: true,
          paidAt: true,
          createdAt: true,
          store: { select: { displayName: true } },
        },
      }),
      this.prisma.payout.count({ where }),
    ]);
    return result(
      data.map(({ store, ...payout }) => ({
        ...payout,
        store: store.displayName,
      })),
      total,
      query.page,
    );
  }

  async registerPayout(input: RegisterPayoutDto, actor: AuthenticatedUser) {
    const requestKey = `${actor.userId}:${input.requestId}`;
    const inputHash = createHash('sha256')
      .update(
        JSON.stringify({
          storeId: input.storeId,
          amountInCents: input.amountInCents,
          scheduledAt: input.scheduledAt ?? null,
          reason: input.reason.trim(),
        }),
      )
      .digest('hex');

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:payout-draft:' + requestKey}))`;
      const previous = await transaction.integrationEvent.findUnique({
        where: {
          provider_externalEventId: {
            provider: 'ADMIN_PAYOUT_DRAFT',
            externalEventId: requestKey,
          },
        },
        select: { payload: true },
      });
      if (previous) {
        const payload = previous.payload as {
          inputHash: string;
          result: {
            id: string;
            status: 'DRAFT';
            store: string;
            amountInCents: number;
            currency: 'PEN';
            scheduledAt: string | null;
          };
        };
        if (payload.inputHash !== inputHash)
          throw new ConflictException(
            'La solicitud ya fue utilizada para otra liquidación.',
          );
        return payload.result;
      }

      const store = await transaction.store.findFirst({
        where: { id: input.storeId, deletedAt: null },
        select: { id: true, displayName: true },
      });
      if (!store) throw new NotFoundException('No se encontró la tienda.');

      const scheduledAt = input.scheduledAt
        ? new Date(input.scheduledAt)
        : null;
      const payout = await transaction.payout.create({
        data: {
          storeId: store.id,
          status: 'DRAFT',
          amountInCents: input.amountInCents,
          currency: 'PEN',
          isDemo: false,
          scheduledAt,
        },
        select: {
          id: true,
          status: true,
          amountInCents: true,
          currency: true,
          scheduledAt: true,
        },
      });
      const result = {
        id: payout.id,
        status: payout.status,
        store: store.displayName,
        amountInCents: payout.amountInCents,
        currency: payout.currency.trim(),
        scheduledAt: payout.scheduledAt?.toISOString() ?? null,
      } as const;

      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          entityType: 'payout',
          entityId: payout.id,
          action: 'PAYOUT_DRAFT_REGISTERED',
          toState: 'DRAFT',
          channel: 'ADMIN_PANEL',
          reason: input.reason.trim(),
          metadata: {
            storeId: store.id,
            amountInCents: payout.amountInCents,
            currency: payout.currency.trim(),
            scheduledAt: payout.scheduledAt?.toISOString() ?? null,
          },
        },
      });
      await transaction.integrationEvent.create({
        data: {
          provider: 'ADMIN_PAYOUT_DRAFT',
          externalEventId: requestKey,
          eventType: 'PAYOUT_DRAFT_REGISTERED',
          status: 'PROCESSED',
          processedAt: new Date(),
          payload: { inputHash, result },
        },
      });
      return result;
    });
  }

  async ledger(query: InformationQueryDto) {
    const where: Prisma.LedgerEntryWhereInput = query.search?.trim()
      ? {
          store: {
            displayName: { contains: query.search.trim(), mode: 'insensitive' },
          },
        }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        ...pagination(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          type: true,
          amountInCents: true,
          currency: true,
          description: true,
          createdAt: true,
          store: { select: { displayName: true } },
        },
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
    return result(
      data.map(({ store, ...entry }) => ({
        ...entry,
        store: store.displayName,
      })),
      total,
      query.page,
    );
  }

  async settings(query: InformationQueryDto) {
    const where: Prisma.SettingWhereInput = {
      key: {
        in: VISIBLE_SETTINGS,
        ...(query.search?.trim()
          ? { contains: query.search.trim(), mode: 'insensitive' as const }
          : {}),
      },
    };
    const [data, total] = await Promise.all([
      this.prisma.setting.findMany({
        where,
        ...pagination(query),
        orderBy: { key: 'asc' },
        select: { key: true, value: true, updatedAt: true },
      }),
      this.prisma.setting.count({ where }),
    ]);
    return result(
      data.map(({ key, value, updatedAt }) => ({
        id: key,
        key,
        value: typeof value === 'number' ? value : null,
        updatedAt,
      })),
      total,
      query.page,
    );
  }

  async calendar(query: InformationQueryDto) {
    const where: Prisma.LogisticsCalendarWhereInput = query.search?.trim()
      ? { description: { contains: query.search.trim(), mode: 'insensitive' } }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.logisticsCalendar.findMany({
        where,
        ...pagination(query),
        orderBy: { date: 'desc' },
        select: { date: true, isWorkingDay: true, description: true },
      }),
      this.prisma.logisticsCalendar.count({ where }),
    ]);
    return result(
      data.map((day) => ({ ...day, id: day.date.toISOString() })),
      total,
      query.page,
    );
  }

  async upsertCalendarDay(
    input: UpsertCalendarDayDto,
    actor: AuthenticatedUser,
  ) {
    const [year, month, dayOfMonth] = input.date.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
    if (date.toISOString().slice(0, 10) !== input.date)
      throw new BadRequestException('La fecha del calendario no es válida.');

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:calendar:' + input.date}))`;
      const previous = await transaction.logisticsCalendar.findUnique({
        where: { date },
      });
      const entry = await transaction.logisticsCalendar.upsert({
        where: { date },
        create: {
          date,
          isWorkingDay: input.isWorkingDay,
          description: input.description?.trim() || null,
        },
        update: {
          isWorkingDay: input.isWorkingDay,
          description: input.description?.trim() || null,
        },
        select: { date: true, isWorkingDay: true, description: true },
      });
      const previousState = previous
        ? previous.isWorkingDay
          ? 'WORKING'
          : 'NON_WORKING'
        : null;
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          entityType: 'logistics_calendar',
          entityId: randomUUID(),
          action: previous
            ? 'LOGISTICS_CALENDAR_DAY_UPDATED'
            : 'LOGISTICS_CALENDAR_DAY_CREATED',
          fromState: previousState,
          toState: entry.isWorkingDay ? 'WORKING' : 'NON_WORKING',
          channel: 'ADMIN_PANEL',
          reason: input.reason.trim(),
          metadata: {
            date: input.date,
            description: entry.description,
          },
        },
      });
      return { ...entry, id: input.date };
    });
  }

  async createShippingRate(
    input: CreateShippingRateDto,
    actor: AuthenticatedUser,
  ) {
    const effectiveFrom = new Date(input.effectiveFrom);
    const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
    if (input.maxItems !== undefined && input.maxItems < input.minItems)
      throw new BadRequestException(
        'La cantidad máxima no puede ser menor que la mínima.',
      );
    if (effectiveTo && effectiveTo <= effectiveFrom)
      throw new BadRequestException(
        'La vigencia final debe ser posterior a la inicial.',
      );
    const district = input.district?.trim() || null;
    const normalizedDistrict = district?.toLocaleLowerCase('es-PE') ?? null;

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:shipping-rate:' + input.zoneType + ':' + (normalizedDistrict ?? '*')}))`;
      const existing = await transaction.shippingRate.findMany({
        where: { zoneType: input.zoneType, active: true },
        select: {
          district: true,
          minItems: true,
          maxItems: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });
      const overlaps = existing.some((rate) => {
        const existingDistrict =
          rate.district?.trim().toLocaleLowerCase('es-PE') ?? null;
        const sameDistrict = existingDistrict === normalizedDistrict;
        const overlapsUnits =
          (input.maxItems === undefined || rate.minItems <= input.maxItems) &&
          (rate.maxItems === null || rate.maxItems >= input.minItems);
        const overlapsDates =
          (!effectiveTo || rate.effectiveFrom < effectiveTo) &&
          (!rate.effectiveTo || rate.effectiveTo > effectiveFrom);
        return sameDistrict && overlapsUnits && overlapsDates;
      });
      if (overlaps)
        throw new ConflictException(
          'Ya existe una tarifa activa con el mismo destino, cantidades y vigencia superpuestas.',
        );

      const rate = await transaction.shippingRate.create({
        data: {
          zoneType: input.zoneType,
          district,
          minItems: input.minItems,
          maxItems: input.maxItems ?? null,
          rateInCents: input.rateInCents,
          currency: 'PEN',
          active: true,
          effectiveFrom,
          effectiveTo,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          entityType: 'shipping_rate',
          entityId: rate.id,
          action: 'SHIPPING_RATE_CREATED',
          toState: 'ACTIVE',
          channel: 'ADMIN_PANEL',
          reason: input.reason.trim(),
          metadata: {
            zoneType: rate.zoneType,
            district: rate.district,
            minItems: rate.minItems,
            maxItems: rate.maxItems,
            rateInCents: rate.rateInCents,
            currency: rate.currency.trim(),
            effectiveFrom: rate.effectiveFrom.toISOString(),
            effectiveTo: rate.effectiveTo?.toISOString() ?? null,
          },
        },
      });
      return rate;
    });
  }

  async shippingRates(query: InformationQueryDto) {
    const where: Prisma.ShippingRateWhereInput = query.search?.trim()
      ? { district: { contains: query.search.trim(), mode: 'insensitive' } }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.shippingRate.findMany({
        where,
        ...pagination(query),
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          zoneType: true,
          district: true,
          minItems: true,
          maxItems: true,
          rateInCents: true,
          currency: true,
          active: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      }),
      this.prisma.shippingRate.count({ where }),
    ]);
    return result(data, total, query.page);
  }
}
