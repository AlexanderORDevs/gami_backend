import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { UsersService } from '../users/users.service.js';
import type { AuthenticatedUser, RequestContext } from '../auth/auth.types.js';
import type { InformationQueryDto } from '../admin-information/admin-information.dto.js';
import { StoreAccessService } from './store-access.service.js';
import {
  StoreInformationResource,
  type CreateStoreUserDto,
  type UpdateStoreMemberDto,
} from './store-workspace.dto.js';

const PAGE_SIZE = 20;
const memberSelect = {
  userId: true,
  role: true,
  active: true,
  isOwner: true,
  user: {
    select: { username: true, displayName: true, email: true, status: true },
  },
} satisfies Prisma.StoreMemberSelect;

function pageResult<T>(data: T[], total: number, page: number) {
  return { data, total, page, pages: Math.ceil(total / PAGE_SIZE) };
}

@Injectable()
export class StoreWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: StoreAccessService,
    private readonly users: UsersService,
  ) {}

  async information(
    storeId: string,
    resource: StoreInformationResource,
    query: InformationQueryDto,
    actor: AuthenticatedUser,
  ) {
    await this.access.require(storeId, actor, resource);
    switch (resource) {
      case StoreInformationResource.products:
        return this.products(storeId, query);
      case StoreInformationResource.inventory:
        return this.inventory(storeId, query);
      case StoreInformationResource.orders:
        return this.orders(storeId, query);
      case StoreInformationResource.shipments:
        return this.shipments(storeId, query);
      case StoreInformationResource.payouts:
        return this.payouts(storeId, query);
      case StoreInformationResource.ledger:
        return this.ledger(storeId, query);
    }
  }

  private async products(storeId: string, query: InformationQueryDto) {
    const where: Prisma.ProductWhereInput = {
      storeId,
      deletedAt: null,
      name: { contains: query.search?.trim(), mode: 'insensitive' },
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
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
          variants: {
            where: { active: true },
            orderBy: { sku: 'asc' },
            select: {
              sizeLabel: true,
              color: true,
              inventory: { select: { quantity: true } },
            },
          },
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    return pageResult(
      rows.map(({ store, variants, ...product }) => ({
        ...product,
        store: store.displayName,
        variants: variants.length,
        variantSummary: variants
          .map(
            (variant) =>
              `${variant.sizeLabel} / ${variant.color}: ${variant.inventory?.quantity ?? '?'}`,
          )
          .join('; '),
      })),
      total,
      query.page,
    );
  }

  private async inventory(storeId: string, query: InformationQueryDto) {
    const where: Prisma.VariantWhereInput = {
      active: true,
      product: { storeId, deletedAt: null },
      ...(query.search?.trim()
        ? {
            OR: [
              {
                sku: {
                  contains: query.search.trim(),
                  mode: 'insensitive' as const,
                },
              },
              {
                product: {
                  name: {
                    contains: query.search.trim(),
                    mode: 'insensitive' as const,
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.variant.findMany({
        where,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        orderBy: [{ sku: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          sku: true,
          sizeLabel: true,
          color: true,
          product: { select: { name: true } },
          inventory: { select: { quantity: true, stockUpdatedAt: true } },
        },
      }),
      this.prisma.variant.count({ where }),
    ]);
    return pageResult(
      rows.map(({ product, inventory, ...variant }) => ({
        ...variant,
        productName: product.name,
        quantity: inventory?.quantity ?? null,
        stockUpdatedAt: inventory?.stockUpdatedAt ?? null,
      })),
      total,
      query.page,
    );
  }

  private async orders(storeId: string, query: InformationQueryDto) {
    const where: Prisma.StoreOrderWhereInput = {
      storeId,
      order: {
        orderNumber: { contains: query.search?.trim(), mode: 'insensitive' },
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.storeOrder.findMany({
        where,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          subtotalInCents: true,
          confirmationDueAt: true,
          confirmedAt: true,
          createdAt: true,
          order: { select: { orderNumber: true } },
          items: {
            select: {
              productName: true,
              sizeLabel: true,
              color: true,
              quantity: true,
            },
          },
        },
      }),
      this.prisma.storeOrder.count({ where }),
    ]);
    return pageResult(
      rows.map(({ order, items, ...row }) => ({
        ...row,
        orderNumber: order.orderNumber,
        totalInCents: row.subtotalInCents,
        stores: 1,
        items: items
          .map(
            (item) =>
              `${item.productName} / ${item.sizeLabel} / ${item.color} x ${item.quantity}`,
          )
          .join('; '),
      })),
      total,
      query.page,
    );
  }

  private async shipments(storeId: string, query: InformationQueryDto) {
    const where: Prisma.ShipmentWhereInput = {
      order: {
        storeOrders: { some: { storeId } },
        orderNumber: { contains: query.search?.trim(), mode: 'insensitive' },
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
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
    return pageResult(
      rows.map(({ order, ...shipment }) => ({
        ...shipment,
        orderNumber: order.orderNumber,
      })),
      total,
      query.page,
    );
  }

  private async payouts(storeId: string, query: InformationQueryDto) {
    const where: Prisma.PayoutWhereInput = { storeId };
    const [rows, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          amountInCents: true,
          scheduledAt: true,
          paidAt: true,
          createdAt: true,
          store: { select: { displayName: true } },
        },
      }),
      this.prisma.payout.count({ where }),
    ]);
    return pageResult(
      rows.map(({ store, ...row }) => ({ ...row, store: store.displayName })),
      total,
      query.page,
    );
  }

  private async ledger(storeId: string, query: InformationQueryDto) {
    const where: Prisma.LedgerEntryWhereInput = {
      storeId,
      ...(query.search?.trim()
        ? {
            description: {
              contains: query.search.trim(),
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          type: true,
          amountInCents: true,
          description: true,
          createdAt: true,
          store: { select: { displayName: true } },
        },
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
    return pageResult(
      rows.map(({ store, ...row }) => ({ ...row, store: store.displayName })),
      total,
      query.page,
    );
  }

  async profile(storeId: string, actor: AuthenticatedUser) {
    await this.access.require(storeId, actor, 'profile');
    return this.prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: {
        id: true,
        displayName: true,
        legalName: true,
        gallery: true,
        standNumber: true,
        whatsappNumber: true,
        status: true,
      },
    });
  }

  async members(
    storeId: string,
    query: InformationQueryDto,
    actor: AuthenticatedUser,
  ) {
    await this.access.require(storeId, actor, 'members');
    const where: Prisma.StoreMemberWhereInput = {
      storeId,
      user: {
        deletedAt: null,
        ...(query.search?.trim()
          ? {
              OR: [
                {
                  username: {
                    contains: query.search.trim(),
                    mode: 'insensitive' as const,
                  },
                },
                {
                  displayName: {
                    contains: query.search.trim(),
                    mode: 'insensitive' as const,
                  },
                },
              ],
            }
          : {}),
      },
    };
    const [data, total] = await Promise.all([
      this.prisma.storeMember.findMany({
        where,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        orderBy: { userId: 'asc' },
        select: memberSelect,
      }),
      this.prisma.storeMember.count({ where }),
    ]);
    return pageResult(
      data.map(({ user, ...membership }) => ({ ...membership, ...user })),
      total,
      query.page,
    );
  }

  async createMember(
    storeId: string,
    input: CreateStoreUserDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await this.lock(storeId, transaction);
      await this.access.require(storeId, actor, 'members', transaction);
      const result = await this.users.create(
        {
          username: input.username,
          displayName: input.displayName,
          email: input.email,
          phone: input.phone,
          storeRole: input.storeRole ?? 'STORE_OPERATOR',
          storeId,
        },
        actor,
        context,
        transaction,
      );
      return {
        temporaryPassword: result.temporaryPassword,
        userId: result.user.id,
      };
    });
  }

  async updateMember(
    storeId: string,
    userId: string,
    input: UpdateStoreMemberDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await this.lock(storeId, transaction);
      await this.access.require(storeId, actor, 'members', transaction);
      const previous = await transaction.storeMember.findFirst({
        where: { storeId, userId, user: { deletedAt: null } },
        select: memberSelect,
      });
      if (!previous) throw new NotFoundException('Store member was not found.');
      if (
        previous.active &&
        previous.role === 'STORE_ADMIN' &&
        (!input.active || input.role !== 'STORE_ADMIN')
      ) {
        const remaining = await transaction.storeMember.count({
          where: {
            storeId,
            userId: { not: userId },
            active: true,
            role: 'STORE_ADMIN',
            user: { status: 'ACTIVE', deletedAt: null },
          },
        });
        if (!remaining)
          throw new BadRequestException(
            'The last active store administrator cannot be removed or demoted.',
          );
      }
      const updated = await transaction.storeMember.update({
        where: { userId_storeId: { userId, storeId } },
        data: { role: input.role, active: input.active },
        select: memberSelect,
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          entityType: 'user',
          entityId: userId,
          action: 'USER_STORE_ROLE_CHANGED',
          channel: actor.roles.includes('SUPER_ADMIN')
            ? 'ADMIN_PANEL'
            : 'STORE_PANEL',
          reason: input.reason,
          metadata: {
            storeId,
            previousRole: previous.role,
            role: input.role,
            previousActive: previous.active,
            active: input.active,
            ipAddress: context.ipAddress ?? 'unknown',
          },
        },
      });
      const { user, ...membership } = updated;
      return { ...membership, ...user };
    });
  }

  private async lock(storeId: string, transaction: Prisma.TransactionClient) {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:store-members:' + storeId}))`;
  }
}
