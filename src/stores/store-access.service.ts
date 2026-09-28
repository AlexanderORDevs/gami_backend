import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, StoreMemberRole } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';

export const STORE_RESOURCES = [
  'products',
  'inventory',
  'orders',
  'shipments',
  'payouts',
  'ledger',
  'members',
  'profile',
] as const;
export type StoreResource = (typeof STORE_RESOURCES)[number];
export const STORE_PERMISSIONS: Record<
  StoreMemberRole,
  readonly StoreResource[]
> = {
  STORE_ADMIN: STORE_RESOURCES,
  STORE_OPERATOR: ['products', 'inventory', 'orders', 'shipments', 'profile'],
  STORE_CATALOG: ['products', 'inventory', 'profile'],
  STORE_ATTENTION: ['products', 'orders', 'profile'],
  STORE_LOGISTICS: ['inventory', 'orders', 'shipments', 'profile'],
  STORE_FINANCE: ['payouts', 'ledger', 'profile'],
};

@Injectable()
export class StoreAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async require(
    storeId: string,
    actor: AuthenticatedUser,
    resource: StoreResource,
    transaction: Prisma.TransactionClient = this.prisma,
  ): Promise<StoreMemberRole> {
    if (actor.roles.includes('SUPER_ADMIN')) {
      const store = await transaction.store.findFirst({
        where: { id: storeId, deletedAt: null },
        select: { id: true },
      });
      if (store) return 'STORE_ADMIN';
    } else {
      const membership = await transaction.storeMember.findFirst({
        where: {
          userId: actor.userId,
          storeId,
          active: true,
          store: { deletedAt: null },
        },
        select: { role: true },
      });
      if (membership && STORE_PERMISSIONS[membership.role].includes(resource))
        return membership.role;
    }
    throw new ForbiddenException(
      'You do not have permission for this store operation.',
    );
  }

  async list(actor: AuthenticatedUser) {
    const globalAdmin = actor.roles.includes('SUPER_ADMIN');
    const stores = await this.prisma.store.findMany({
      where: {
        deletedAt: null,
        ...(globalAdmin
          ? {}
          : { members: { some: { userId: actor.userId, active: true } } }),
      },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        displayName: true,
        status: true,
        members: {
          where: { userId: actor.userId, active: true },
          select: { role: true },
        },
      },
    });
    return stores.map(({ members, ...store }) => {
      const role = globalAdmin ? 'STORE_ADMIN' : members[0].role;
      return { ...store, role, permissions: STORE_PERMISSIONS[role] };
    });
  }
}
