import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { UsersService } from './users.service.js';

const actor: AuthenticatedUser = {
  userId: '39ca2c8b-9fc5-4242-b449-29462d55ae57',
  sessionId: 'fa1cbb1b-b558-416f-a430-514e770cce1a',
  username: 'alexander',
  displayName: 'Alexander',
  roles: ['SUPER_ADMIN'],
  storeIds: [],
  mustChangePassword: false,
};
const targetUserId = 'f76362cf-8940-4164-a6ee-bda9098ad8ee';
const context = { ipAddress: '127.0.0.1', userAgent: 'vitest' };

it.skipIf(process.env.RUN_USERS_INTEGRATION !== '1')(
  'persists optional store scope, role and audit together in PostgreSQL and rolls back the fixtures',
  async () => {
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const prisma = new PrismaService(new ConfigService(environment));
    const prefix = `user-test-${randomUUID()}`;
    const rollback = new Error('Rollback user creation fixtures');
    try {
      await expect(
        prisma.$transaction(
          async (transaction) => {
            const administrator = await transaction.user.findFirstOrThrow({
              where: {
                status: 'ACTIVE',
                deletedAt: null,
                roles: { some: { role: { code: 'SUPER_ADMIN' } } },
              },
              select: { id: true },
            });
            const store = await transaction.store.findFirstOrThrow({
              where: { deletedAt: null },
              select: { id: true },
            });
            const service = new UsersService({
              $transaction: (
                operation: (client: typeof transaction) => Promise<unknown>,
              ) => operation(transaction),
            } as unknown as PrismaService);
            for (const mode of ['none', 'member', 'owner']) {
              const username = `${prefix}-${mode}`;
              const result = await service.create(
                {
                  username,
                  displayName: 'User creation integration fixture',
                  email: `${username}@example.com`,
                  ...(mode === 'none'
                    ? {}
                    : { storeId: store.id, isOwner: mode === 'owner' }),
                },
                { ...actor, userId: administrator.id },
                context,
              );
              expect(result.user.mustChangePassword).toBe(true);
              expect(result.user.roles).toEqual(
                mode === 'none' ? [] : ['STORE_OPERATOR'],
              );
              expect(result.user.storeMemberships).toHaveLength(
                mode === 'none' ? 0 : 1,
              );
              if (mode !== 'none')
                expect(result.user.storeMemberships[0]).toMatchObject({
                  storeId: store.id,
                  active: true,
                  isOwner: mode === 'owner',
                });
              const events = await transaction.auditLog.findMany({
                where: { entityType: 'user', entityId: result.user.id },
                select: { action: true },
              });
              expect(events.map((event) => event.action).sort()).toEqual(
                mode === 'none'
                  ? ['USER_CREATED']
                  : [
                      'USER_CREATED',
                      'USER_ROLE_GRANTED',
                      'USER_STORE_ACCESS_GRANTED',
                    ],
              );
            }
            throw rollback;
          },
          { timeout: 15000 },
        ),
      ).rejects.toBe(rollback);
      expect(
        await prisma.user.count({
          where: { username: { startsWith: prefix } },
        }),
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  },
);

function selectedUser(overrides: Record<string, unknown> = {}) {
  return {
    id: targetUserId,
    username: 'operator',
    displayName: 'Operator',
    email: null,
    phone: null,
    status: 'ACTIVE',
    mustChangePassword: true,
    lastLoginAt: null,
    createdAt: new Date('2026-09-09T10:00:00Z'),
    updatedAt: new Date('2026-09-09T10:00:00Z'),
    roles: [{ role: { code: 'SUPER_ADMIN' } }],
    storeMemberships: [],
    ...overrides,
  };
}

describe('UsersService', () => {
  it('prevents an administrator from blocking their own account', async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new UsersService(prisma as unknown as PrismaService);

    await expect(
      service.updateStatus(
        actor.userId,
        'SUSPENDED',
        'Self lockout attempt',
        actor,
        context,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('prevents blocking the last active SUPER_ADMIN under an advisory lock', async () => {
    const transaction = {
      user: {
        findFirst: vi.fn().mockResolvedValue(selectedUser()),
        count: vi.fn().mockResolvedValue(1),
      },
      userRole: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    };
    const service = new UsersService(prisma as unknown as PrismaService);

    await expect(
      service.updateStatus(
        targetUserId,
        'SUSPENDED',
        'Administrative suspension',
        actor,
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction.$executeRaw).toHaveBeenCalledOnce();
  });

  it('creates a temporary credential and audit event atomically', async () => {
    const createdUser = selectedUser({ roles: [] });
    const transaction = {
      user: { create: vi.fn().mockResolvedValue(createdUser) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    };
    const service = new UsersService(prisma as unknown as PrismaService);

    const result = await service.create(
      {
        username: 'operator',
        displayName: 'Operator',
        email: 'operator@example.com',
      },
      actor,
      context,
    );
    const persistedPasswordHash = transaction.user.create.mock.calls[0]?.[0]
      ?.data.passwordHash as string;

    expect(result.temporaryPassword).toHaveLength(24);
    expect(persistedPasswordHash).not.toBe(result.temporaryPassword);
    expect(persistedPasswordHash.startsWith('$2')).toBe(true);
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: actor.userId,
        entityId: targetUserId,
        action: 'USER_CREATED',
        channel: 'ADMIN_PANEL',
      }),
    });
  });

  it('prevents revoking the current administrator own SUPER_ADMIN role', async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new UsersService(prisma as unknown as PrismaService);

    await expect(
      service.revokeRole(
        actor.userId,
        'SUPER_ADMIN',
        'Self demotion attempt',
        actor,
        context,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'creates a store operator with ownership %s atomically',
    async (isOwner) => {
      const storeId = 'ab9d0102-794e-4d6b-9185-d8e89b28fdcc';
      const role = isOwner ? 'STORE_ADMIN' : 'STORE_OPERATOR';
      const transaction = {
        store: { findFirst: vi.fn().mockResolvedValue({ id: storeId }) },
        role: {
          findUnique: vi.fn().mockResolvedValue({ code: 'STORE_OPERATOR' }),
        },
        user: {
          create: vi.fn().mockResolvedValue(
            selectedUser({
              roles: [{ role: { code: 'STORE_OPERATOR' } }],
              storeMemberships: [
                {
                  storeId,
                  isOwner,
                  active: true,
                  role,
                  store: { displayName: 'Test store' },
                },
              ],
            }),
          ),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      const prisma = {
        $transaction: vi.fn(
          async (operation: (client: typeof transaction) => Promise<unknown>) =>
            operation(transaction),
        ),
      };
      const service = new UsersService(prisma as unknown as PrismaService);
      const result = await service.create(
        {
          username: 'operator',
          displayName: 'Operator',
          email: 'operator@example.com',
          storeId,
          isOwner,
        },
        actor,
        context,
      );

      expect(transaction.store.findFirst).toHaveBeenCalledWith({
        where: { id: storeId, deletedAt: null },
      });
      expect(transaction.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            roles: {
              create: { role: { connect: { code: 'STORE_OPERATOR' } } },
            },
            storeMemberships: {
              create: {
                store: { connect: { id: storeId } },
                active: true,
                isOwner,
                role,
              },
            },
          }),
        }),
      );
      expect(result.user.roles).toEqual(['STORE_OPERATOR']);
      expect(result.user.storeMemberships).toEqual([
        { storeId, storeName: 'Test store', isOwner, active: true, role },
      ]);
      expect(transaction.auditLog.create).toHaveBeenCalledTimes(3);
      expect(prisma.$transaction).toHaveBeenCalledOnce();
    },
  );

  it.each(['store', 'role'])(
    'does not create the user when the selected %s is missing',
    async (missing) => {
      const transaction = {
        store: {
          findFirst: vi
            .fn()
            .mockResolvedValue(missing === 'store' ? null : { id: 'store' }),
        },
        role: { findUnique: vi.fn().mockResolvedValue(null) },
        user: { create: vi.fn() },
      };
      const prisma = {
        $transaction: vi.fn(
          async (operation: (client: typeof transaction) => Promise<unknown>) =>
            operation(transaction),
        ),
      };
      const service = new UsersService(prisma as unknown as PrismaService);
      await expect(
        service.create(
          {
            username: 'operator',
            displayName: 'Operator',
            email: 'operator@example.com',
            storeId: 'ab9d0102-794e-4d6b-9185-d8e89b28fdcc',
          },
          actor,
          context,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(transaction.user.create).not.toHaveBeenCalled();
    },
  );

  it('rejects ownership without a store before creating an account', async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new UsersService(prisma as unknown as PrismaService);
    await expect(
      service.create(
        {
          username: 'operator',
          displayName: 'Operator',
          email: 'operator@example.com',
          isOwner: true,
        },
        actor,
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
