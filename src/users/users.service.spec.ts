import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service.js';
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
      { username: 'operator', displayName: 'Operator' },
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
});
