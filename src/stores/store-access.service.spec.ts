import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import type { PrismaService } from '../database/prisma.service.js';
import {
  StoreAccessService,
  STORE_PERMISSIONS,
} from './store-access.service.js';

const actor: AuthenticatedUser = {
  userId: 'store-user',
  sessionId: 'session',
  username: 'operator',
  displayName: 'Operator',
  roles: ['STORE_OPERATOR'],
  storeIds: ['assigned-store'],
  mustChangePassword: false,
};

describe('StoreAccessService', () => {
  it.each(Object.keys(STORE_PERMISSIONS))(
    'checks the current membership and permissions for %s',
    async (role) => {
      const findFirst = vi.fn().mockResolvedValue({ role });
      const access = new StoreAccessService({
        storeMember: { findFirst },
      } as unknown as PrismaService);
      await expect(
        access.require('assigned-store', actor, 'profile'),
      ).resolves.toBe(role);
      expect(findFirst).toHaveBeenCalledWith({
        where: {
          userId: actor.userId,
          storeId: 'assigned-store',
          active: true,
          store: { deletedAt: null },
        },
        select: { role: true },
      });
      if (role !== 'STORE_ADMIN')
        await expect(
          access.require('assigned-store', actor, 'members'),
        ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('does not trust store IDs or global store roles without a current membership', async () => {
    const access = new StoreAccessService({
      storeMember: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService);
    await expect(
      access.require('assigned-store', actor, 'products'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      access.require(
        'other-store',
        { ...actor, roles: ['STORE_ADMIN'] },
        'members',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not grant finance permissions to catalog staff', async () => {
    const access = new StoreAccessService({
      storeMember: {
        findFirst: vi.fn().mockResolvedValue({ role: 'STORE_CATALOG' }),
      },
    } as unknown as PrismaService);
    await expect(
      access.require('assigned-store', actor, 'ledger'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a platform superadmin only for an existing nondeleted store', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'store' });
    const access = new StoreAccessService({
      store: { findFirst },
    } as unknown as PrismaService);
    await expect(
      access.require('store', { ...actor, roles: ['SUPER_ADMIN'] }, 'members'),
    ).resolves.toBe('STORE_ADMIN');
    findFirst.mockResolvedValue(null);
    await expect(
      access.require(
        'deleted-store',
        { ...actor, roles: ['SUPER_ADMIN'] },
        'members',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
