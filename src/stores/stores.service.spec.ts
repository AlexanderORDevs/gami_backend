import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Prisma } from '../generated/prisma/client.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CreateStoreDto } from './stores.dto.js';
import { StoresService } from './stores.service.js';
import { StoresController } from './stores.controller.js';

const actor = { userId: 'admin-id' } as AuthenticatedUser;
const input = {
  displayName: 'Tienda prueba',
  legalName: '',
  gallery: 'Galería',
  standNumber: '101',
  whatsappNumber: '+51987654321',
  hours: [{ dayOfWeek: 1, opensAt: '09:00', closesAt: '18:00' }],
  reason: 'Alta de expediente',
};
const existing = {
  id: 'store-id',
  ...input,
  legalName: null,
  status: 'APPLIED',
  createdAt: new Date(),
  updatedAt: new Date('2026-09-17T10:00:00Z'),
  whatsappVerifiedAt: new Date(),
  hours: [],
  members: [],
};

function fixture() {
  const transaction = {
    store: {
      create: vi.fn().mockResolvedValue(existing),
      findFirst: vi.fn().mockResolvedValue(existing),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(existing),
    },
    storeHour: { deleteMany: vi.fn(), createMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(
      async (operation: (client: typeof transaction) => unknown) =>
        operation(transaction),
    ),
  };
  return {
    transaction,
    prisma,
    service: new StoresService(prisma as unknown as PrismaService),
  };
}

describe('StoresService', () => {
  it('protects detail, history, creation and editing with all three guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, StoresController)).toEqual([
      JwtAuthGuard,
      PasswordChangedGuard,
      RolesGuard,
    ]);
    for (const method of ['detail', 'history', 'create', 'update'] as const) {
      const context = (roles: string[], mustChangePassword = false) =>
        ({
          getClass: () => StoresController,
          getHandler: () => StoresController.prototype[method],
          switchToHttp: () => ({
            getRequest: () => ({ user: { roles, mustChangePassword } }),
          }),
        }) as unknown as ExecutionContext;
      const guard = new RolesGuard(new Reflector());
      expect(guard.canActivate(context(['SUPER_ADMIN']))).toBe(true);
      expect(() => guard.canActivate(context(['STORE_OPERATOR']))).toThrow(
        ForbiddenException,
      );
      expect(() => guard.canActivate(context([]))).toThrow(ForbiddenException);
      expect(() =>
        new PasswordChangedGuard().canActivate(context(['SUPER_ADMIN'], true)),
      ).toThrow(ForbiddenException);
    }
  });

  it('does not report success when transactional audit fails', async () => {
    const { transaction, service } = fixture();
    transaction.auditLog.create.mockRejectedValue(
      new Error('Audit unavailable'),
    );
    await expect(service.create(input, actor, {})).rejects.toThrow(
      'Audit unavailable',
    );
  });

  it('reports unique WhatsApp conflicts without returning database details', async () => {
    const { transaction, service } = fixture();
    transaction.store.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '7',
      }),
    );
    await expect(service.create(input, actor, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('does not edit missing or soft-deleted stores', async () => {
    const { transaction, service } = fixture();
    transaction.store.findFirst.mockResolvedValue(null);
    await expect(
      service.update(
        existing.id,
        { ...input, updatedAt: existing.updatedAt.toISOString() },
        actor,
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction.store.findFirst.mock.calls[0][0].where).toEqual({
      id: existing.id,
      deletedAt: null,
    });
    expect(transaction.store.updateMany).not.toHaveBeenCalled();
  });

  it.each(['CLOSED', 'REJECTED'])(
    'preserves terminal state %s',
    async (status) => {
      const { transaction, service } = fixture();
      transaction.store.findFirst.mockResolvedValue({ ...existing, status });
      await expect(
        service.update(
          existing.id,
          { ...input, updatedAt: existing.updatedAt.toISOString() },
          actor,
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transaction.store.updateMany).not.toHaveBeenCalled();
    },
  );

  it('preserves verification when the number does not change and never mutates status', async () => {
    const { transaction, service } = fixture();
    await service.update(
      existing.id,
      { ...input, updatedAt: existing.updatedAt.toISOString() },
      actor,
      {},
    );
    const data = transaction.store.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('whatsappVerifiedAt');
    expect(data).not.toHaveProperty('status');
  });

  it('does not remove every operating hour of an active store', async () => {
    const { transaction, service } = fixture();
    transaction.store.findFirst.mockResolvedValue({
      ...existing,
      status: 'ACTIVE',
    });
    await expect(
      service.update(
        existing.id,
        { ...input, hours: [], updatedAt: existing.updatedAt.toISOString() },
        actor,
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid nested hours and forced WhatsApp verification', async () => {
    const errors = await validate(
      plainToInstance(CreateStoreDto, {
        ...input,
        whatsappVerifiedAt: new Date().toISOString(),
        hours: [{ dayOfWeek: 7, opensAt: '25:00', closesAt: '' }],
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['whatsappVerifiedAt', 'hours']),
    );
    expect(
      errors
        .find((error) => error.property === 'hours')
        ?.children?.[0].children?.map((error) => error.property),
    ).toEqual(expect.arrayContaining(['dayOfWeek', 'opensAt', 'closesAt']));
  });

  it('creates an applied store and audit in the same transaction, without automatic verification', async () => {
    const { transaction, service } = fixture();
    await service.create(input, actor, {});
    expect(transaction.store.create.mock.calls[0][0].data).toMatchObject({
      status: 'APPLIED',
      legalName: null,
    });
    expect(transaction.store.create.mock.calls[0][0].data).not.toHaveProperty(
      'whatsappVerifiedAt',
    );
    expect(transaction.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entityType: 'store',
      action: 'STORE_CREATED',
      actorUserId: 'admin-id',
      reason: input.reason,
    });
  });

  it.each([
    [{ dayOfWeek: 1, opensAt: '18:00', closesAt: '09:00' }],
    [
      { dayOfWeek: 1, opensAt: '09:00', closesAt: '12:00' },
      { dayOfWeek: 1, opensAt: '11:00', closesAt: '13:00' },
    ],
  ])(
    'rejects inverted or overlapping hours before writing',
    async (...hours) => {
      const { service, prisma } = fixture();
      await expect(
        service.create({ ...input, hours }, actor, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('accepts split shifts and stores wall-clock times without local timezone conversion', async () => {
    const { transaction, service } = fixture();
    await service.create(
      {
        ...input,
        hours: [
          { dayOfWeek: 1, opensAt: '09:00', closesAt: '12:00' },
          { dayOfWeek: 1, opensAt: '14:00', closesAt: '18:00' },
        ],
      },
      actor,
      {},
    );
    expect(
      transaction.store.create.mock.calls[0][0].data.hours.create[0].opensAt.toISOString(),
    ).toBe('1970-01-01T09:00:00.000Z');
  });

  it('rejects stale edits before replacing hours or recording a successful audit', async () => {
    const { transaction, service } = fixture();
    transaction.store.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update(
        existing.id,
        { ...input, updatedAt: existing.updatedAt.toISOString() },
        actor,
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.storeHour.deleteMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('invalidates WhatsApp verification when the number changes', async () => {
    const { transaction, service } = fixture();
    await service.update(
      existing.id,
      {
        ...input,
        whatsappNumber: '+51911111111',
        updatedAt: existing.updatedAt.toISOString(),
      },
      actor,
      {},
    );
    expect(
      transaction.store.updateMany.mock.calls[0][0].data.whatsappVerifiedAt,
    ).toBeNull();
    expect(transaction.storeHour.createMany).toHaveBeenCalled();
  });

  it('rejects invalid fields and a forged active status through DTO validation', async () => {
    const dto = plainToInstance(CreateStoreDto, {
      ...input,
      displayName: ' ',
      whatsappNumber: '987654321',
      status: 'ACTIVE',
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['displayName', 'whatsappNumber', 'status']),
    );
  });
});
