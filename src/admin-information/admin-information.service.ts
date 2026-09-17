import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { InformationQueryDto } from './admin-information.dto.js';

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
