import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { AdminInformationService } from './admin-information.service.js';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import { AdminInformationController } from './admin-information.controller.js';
import {
  CreateShippingRateDto,
  RegisterPayoutDto,
  SetAgencyCommissionRateDto,
  UpsertCalendarDayDto,
} from './admin-information.dto.js';
import { ConflictException } from '@nestjs/common';
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

function createHashForTest(input: {
  storeId: string;
  amountInCents: number;
  scheduledAt?: string;
  reason: string;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        storeId: input.storeId,
        amountInCents: input.amountInCents,
        scheduledAt: input.scheduledAt ?? null,
        reason: input.reason.trim(),
      }),
    )
    .digest('hex');
}

describe('AdminInformationService', () => {
  it('protects every information route with session, password and role guards', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminInformationController),
    ).toEqual([JwtAuthGuard, PasswordChangedGuard, RolesGuard]);
    for (const method of [
      'stores',
      'products',
      'orders',
      'shipments',
      'payouts',
      'registerPayout',
      'ledger',
      'settings',
      'setAgencyCommissionRate',
      'calendar',
      'upsertCalendarDay',
      'shippingRates',
      'createShippingRate',
    ] as const) {
      const context = (roles: string[], mustChangePassword = false) =>
        ({
          getClass: () => AdminInformationController,
          getHandler: () => AdminInformationController.prototype[method],
          switchToHttp: () => ({
            getRequest: () => ({ user: { roles, mustChangePassword } }),
          }),
        }) as unknown as ExecutionContext;
      const rolesGuard = new RolesGuard(new Reflector());
      expect(rolesGuard.canActivate(context(['SUPER_ADMIN']))).toBe(true);
      expect(() => rolesGuard.canActivate(context(['STORE_OPERATOR']))).toThrow(
        ForbiddenException,
      );
      expect(() => rolesGuard.canActivate(context([]))).toThrow(
        ForbiddenException,
      );
      expect(() =>
        new PasswordChangedGuard().canActivate(context(['SUPER_ADMIN'], true)),
      ).toThrow(ForbiddenException);
    }
  });

  it.each([
    ['products', 'product'],
    ['orders', 'order'],
    ['shipments', 'shipment'],
    ['payouts', 'payout'],
    ['ledger', 'ledgerEntry'],
    ['settings', 'setting'],
    ['calendar', 'logisticsCalendar'],
    ['shippingRates', 'shippingRate'],
  ] as const)(
    'reads %s with explicit fields, matching filters and a bounded page',
    async (method, model) => {
      const delegate = {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      };
      const service = new AdminInformationService({
        [model]: delegate,
      } as unknown as PrismaService);
      expect(await service[method]({ page: 1, search: 'test' })).toEqual({
        data: [],
        total: 0,
        page: 1,
        pages: 0,
      });
      const args = delegate.findMany.mock.calls[0][0];
      expect(args).toMatchObject({
        take: 20,
        skip: 0,
        select: expect.any(Object),
      });
      if (method === 'payouts')
        expect(args.select).toHaveProperty('isDemo', true);
      expect(delegate.count.mock.calls[0][0].where).toEqual(args.where);
      for (const privateField of [
        'providerData',
        'metadata',
        'idempotencyKey',
        'receiptUrl',
        'customer',
        'shippingAddress',
      ]) {
        expect(args.select).not.toHaveProperty(privateField);
      }
    },
  );

  it('limits settings to known numeric business keys and suppresses unexpected values', async () => {
    const setting = {
      findMany: vi.fn().mockResolvedValue([
        {
          key: 'stock_hold_ttl_minutes',
          value: { secret: 'hidden' },
          updatedAt: new Date(),
        },
      ]),
      count: vi.fn().mockResolvedValue(1),
    };
    const service = new AdminInformationService({
      setting,
    } as unknown as PrismaService);
    const response = await service.settings({ page: 1 });
    expect(setting.findMany.mock.calls[0][0].where.key.in).toContain(
      'stock_hold_ttl_minutes',
    );
    expect(setting.findMany.mock.calls[0][0].where.key.in).not.toContain(
      'SMTP_PASSWORD',
    );
    expect(response.data[0].value).toBeNull();
  });

  it('audits the agency commission rate without supplying a default', async () => {
    const setting = {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({
        updatedAt: new Date('2026-11-10T12:00:00.000Z'),
      }),
    };
    const auditLog = { create: vi.fn() };
    const transaction = {
      $executeRaw: vi.fn(),
      setting,
      auditLog,
    };
    const service = new AdminInformationService({
      $transaction: (operation: (tx: typeof transaction) => unknown) =>
        operation(transaction),
    } as unknown as PrismaService);
    const response = await service.setAgencyCommissionRate(
      { rateBasisPoints: 1250, reason: 'Tarifa aprobada por Finanzas' },
      { userId: 'admin-id' } as AuthenticatedUser,
    );
    expect(setting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'commission_rate_basis_points_agency' },
        create: expect.objectContaining({ value: 1250 }),
        update: expect.objectContaining({ value: 1250 }),
      }),
    );
    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AGENCY_COMMISSION_RATE_CONFIGURED',
          reason: 'Tarifa aprobada por Finanzas',
          metadata: expect.objectContaining({
            rateBasisPoints: 1250,
            treatment: 'DEDUCTED_FROM_LISTED_PRICE',
          }),
        }),
      }),
    );
    expect(response.rateBasisPoints).toBe(1250);
  });

  it('validates the commission rate in basis points', async () => {
    const options = { whitelist: true, forbidNonWhitelisted: true };
    for (const rateBasisPoints of [-1, 10001, 1.5]) {
      expect(
        await validate(
          plainToInstance(SetAgencyCommissionRateDto, {
            rateBasisPoints,
            reason: 'Aprobación',
          }),
          options,
        ),
      ).not.toHaveLength(0);
    }
    expect(
      await validate(
        plainToInstance(SetAgencyCommissionRateDto, {
          rateBasisPoints: 0,
          reason: 'Sin comisión aprobada',
          commercialModel: 'RESELLER',
        }),
        options,
      ),
    ).not.toHaveLength(0);
  });

  it('registers an audited PEN draft without creating ledger entries', async () => {
    const payout = {
      id: 'payout-id',
      status: 'DRAFT',
      amountInCents: 12500,
      currency: 'PEN',
      isDemo: false,
      scheduledAt: new Date('2026-12-01T10:00:00.000Z'),
    };
    const transaction = {
      $executeRaw: vi.fn(),
      integrationEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      store: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'store-id',
          displayName: 'Tienda Demo',
        }),
      },
      payout: { create: vi.fn().mockResolvedValue(payout) },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((operation) => operation(transaction)),
    };
    const service = new AdminInformationService(
      prisma as unknown as PrismaService,
    );
    const input = {
      requestId: '01234567-89ab-4cde-8fab-0123456789ab',
      storeId: '11234567-89ab-4cde-8fab-0123456789ab',
      amountInCents: 12500,
      scheduledAt: '2026-12-01T10:00:00.000Z',
      reason: 'Registrar liquidación pendiente de revisión',
    };
    const actor = {
      userId: '21234567-89ab-4cde-8fab-0123456789ab',
      roles: ['SUPER_ADMIN'],
    } as AuthenticatedUser;

    await expect(service.registerPayout(input, actor)).resolves.toEqual({
      id: 'payout-id',
      status: 'DRAFT',
      store: 'Tienda Demo',
      amountInCents: 12500,
      currency: 'PEN',
      scheduledAt: '2026-12-01T10:00:00.000Z',
    });
    expect(transaction.payout.create.mock.calls[0][0].data).toEqual({
      storeId: 'store-id',
      status: 'DRAFT',
      amountInCents: 12500,
      currency: 'PEN',
      scheduledAt: new Date('2026-12-01T10:00:00.000Z'),
      isDemo: false,
    });
    expect(transaction.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entityType: 'payout',
      entityId: 'payout-id',
      action: 'PAYOUT_DRAFT_REGISTERED',
      toState: 'DRAFT',
      reason: input.reason,
    });
    expect(transaction.integrationEvent.create).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveProperty('ledgerEntry');
  });

  it('replays a payout draft only when its idempotent payload matches', async () => {
    const input = {
      requestId: '01234567-89ab-4cde-8fab-0123456789ab',
      storeId: '11234567-89ab-4cde-8fab-0123456789ab',
      amountInCents: 12500,
      reason: 'Liquidación pendiente',
    };
    const result = {
      id: 'payout-id',
      status: 'DRAFT',
      store: 'Tienda Demo',
      amountInCents: 12500,
      currency: 'PEN',
      scheduledAt: null,
    };
    const previous = {
      integrationEvent: {
        findUnique: vi.fn().mockResolvedValue({
          payload: {
            inputHash: createHashForTest(input),
            result,
          },
        }),
        create: vi.fn(),
      },
      $executeRaw: vi.fn(),
      store: { findFirst: vi.fn() },
      payout: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const service = new AdminInformationService({
      $transaction: (operation) => operation(previous),
    } as unknown as PrismaService);
    const actor = {
      userId: '21234567-89ab-4cde-8fab-0123456789ab',
    } as AuthenticatedUser;

    await expect(service.registerPayout(input, actor)).resolves.toEqual(result);
    await expect(
      service.registerPayout({ ...input, amountInCents: 13000 }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(previous.payout.create).not.toHaveBeenCalled();
    expect(previous.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects invalid payout amount, store, date, reason, and injected status', async () => {
    const valid = {
      requestId: '01234567-89ab-4cde-8fab-0123456789ab',
      storeId: '11234567-89ab-4cde-8fab-0123456789ab',
      amountInCents: 12500,
      reason: 'Liquidación pendiente',
    };
    const options = { whitelist: true, forbidNonWhitelisted: true };
    expect(
      await validate(plainToInstance(RegisterPayoutDto, valid), options),
    ).toHaveLength(0);
    for (const patch of [
      { amountInCents: 0 },
      { storeId: 'not-a-uuid' },
      { scheduledAt: 'next week' },
      { reason: '  ' },
      { status: 'PAID' },
    ]) {
      expect(
        (
          await validate(
            plainToInstance(RegisterPayoutDto, { ...valid, ...patch }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it('creates a tariff with a reason and refuses overlapping active rules', async () => {
    const tariff = {
      id: 'rate-id',
      zoneType: 'LIMA',
      district: 'La Victoria',
      minItems: 1,
      maxItems: 3,
      rateInCents: 1200,
      currency: 'PEN',
      active: true,
      effectiveFrom: new Date('2026-11-09T12:00:00.000Z'),
      effectiveTo: new Date('2026-12-01T12:00:00.000Z'),
    };
    const transaction = {
      $executeRaw: vi.fn(),
      shippingRate: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(tariff),
      },
      auditLog: { create: vi.fn() },
    };
    const service = new AdminInformationService({
      $transaction: (operation) => operation(transaction),
    } as unknown as PrismaService);
    const actor = {
      userId: '21234567-89ab-4cde-8fab-0123456789ab',
    } as AuthenticatedUser;
    const input = {
      zoneType: 'LIMA' as const,
      district: 'La Victoria',
      minItems: 1,
      maxItems: 3,
      rateInCents: 1200,
      effectiveFrom: tariff.effectiveFrom.toISOString(),
      effectiveTo: tariff.effectiveTo.toISOString(),
      reason: 'Tarifa aprobada por logística',
    };

    await expect(service.createShippingRate(input, actor)).resolves.toEqual(
      tariff,
    );
    expect(transaction.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entityType: 'shipping_rate',
      entityId: 'rate-id',
      action: 'SHIPPING_RATE_CREATED',
      reason: input.reason,
    });

    transaction.shippingRate.findMany.mockResolvedValue([
      {
        district: 'la victoria',
        minItems: 2,
        maxItems: 4,
        effectiveFrom: new Date('2026-11-20T00:00:00.000Z'),
        effectiveTo: null,
      },
    ]);
    await expect(
      service.createShippingRate(input, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.shippingRate.create).toHaveBeenCalledOnce();
  });

  it('upserts calendar dates by Lima day and audits the actor change', async () => {
    const date = new Date('2026-12-25T00:00:00.000Z');
    const transaction = {
      $executeRaw: vi.fn(),
      logisticsCalendar: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({
          date,
          isWorkingDay: false,
          description: 'Navidad',
        }),
      },
      auditLog: { create: vi.fn() },
    };
    const service = new AdminInformationService({
      $transaction: (operation) => operation(transaction),
    } as unknown as PrismaService);
    const actor = {
      userId: '21234567-89ab-4cde-8fab-0123456789ab',
    } as AuthenticatedUser;
    const input = {
      date: '2026-12-25',
      isWorkingDay: false,
      description: 'Navidad',
      reason: 'Feriado confirmado por logística',
    };

    await expect(service.upsertCalendarDay(input, actor)).resolves.toEqual({
      date,
      isWorkingDay: false,
      description: 'Navidad',
      id: input.date,
    });
    expect(transaction.auditLog.create.mock.calls[0][0].data).toMatchObject({
      actorUserId: actor.userId,
      entityType: 'logistics_calendar',
      action: 'LOGISTICS_CALENDAR_DAY_CREATED',
      toState: 'NON_WORKING',
      reason: input.reason,
    });
    await expect(
      service.upsertCalendarDay({ ...input, date: '2026-02-31' }, actor),
    ).rejects.toThrow('fecha del calendario no es válida');
  });

  it('validates shipping-rate and calendar input instead of accepting injected policy fields', async () => {
    const rate = {
      zoneType: 'LIMA',
      district: 'La Victoria',
      minItems: 1,
      maxItems: 3,
      rateInCents: 1200,
      effectiveFrom: '2026-11-09T12:00:00.000Z',
      reason: 'Tarifa aprobada',
    };
    const options = { whitelist: true, forbidNonWhitelisted: true };
    expect(
      await validate(plainToInstance(CreateShippingRateDto, rate), options),
    ).toHaveLength(0);
    for (const patch of [
      { zoneType: 'OTHER' },
      { rateInCents: 0 },
      { rateInCents: -1 },
      { minItems: 0 },
      { active: false },
    ])
      expect(
        (
          await validate(
            plainToInstance(CreateShippingRateDto, { ...rate, ...patch }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);

    const calendar = {
      date: '2026-12-25',
      isWorkingDay: false,
      description: 'Feriado',
      reason: 'Calendario oficial',
    };
    expect(
      await validate(plainToInstance(UpsertCalendarDayDto, calendar), options),
    ).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(UpsertCalendarDayDto, {
            ...calendar,
            isWorkingDay: 'false',
          }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('paginates stores with matching counts and excludes deleted records', async () => {
    const store = {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(21),
    };
    const service = new AdminInformationService({
      store,
    } as unknown as PrismaService);
    expect(await service.stores({ page: 2, search: ' Local ' })).toEqual({
      data: [],
      total: 21,
      page: 2,
      pages: 2,
    });
    expect(store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        where: {
          deletedAt: null,
          displayName: { contains: 'Local', mode: 'insensitive' },
        },
        select: expect.objectContaining({ id: true, displayName: true }),
      }),
    );
    expect(store.count.mock.calls[0][0].where).toEqual(
      store.findMany.mock.calls[0][0].where,
    );
    expect(store.findMany.mock.calls[0][0].select).not.toHaveProperty(
      'whatsappNumber',
    );
  });

  it.skipIf(process.env.RUN_LOGISTICS_CONFIG_INTEGRATION !== '1')(
    'writes audited rates and calendar dates on local PostgreSQL, then rolls back',
    async () => {
      const { readFileSync } = await import('node:fs');
      const { randomUUID } = await import('node:crypto');
      const { parse } = await import('dotenv');
      const { ConfigService } = await import('@nestjs/config');
      const environment = parse(
        readFileSync(new URL('../../.env', import.meta.url)),
      );
      expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
      const database = new PrismaService(new ConfigService(environment));
      const rollback = new Error('Rollback logistics configuration fixture');
      let rateId = '';
      const suffix = randomUUID().slice(0, 8);
      const calendarDate = new Date('2400-01-01T00:00:00.000Z');
      try {
        await expect(
          database.$transaction(
            async (transaction) => {
              const admin = await transaction.user.findFirstOrThrow({
                where: {
                  status: 'ACTIVE',
                  roles: { some: { role: { code: 'SUPER_ADMIN' } } },
                },
                select: { id: true },
              });
              const isolated = new Proxy(transaction, {
                get(target, property) {
                  if (property === '$transaction')
                    return (
                      operation: (
                        client: typeof transaction,
                      ) => Promise<unknown>,
                    ) => operation(transaction);
                  return Reflect.get(target, property);
                },
              });
              const service = new AdminInformationService(
                isolated as unknown as PrismaService,
              );
              const actor = {
                userId: admin.id,
                roles: ['SUPER_ADMIN'],
              } as AuthenticatedUser;
              const effectiveFrom = new Date(Date.now() + 60000);
              const effectiveTo = new Date(effectiveFrom.getTime() + 3600000);
              const input = {
                zoneType: 'LIMA' as const,
                district: `TEST-${suffix}`,
                minItems: 1,
                maxItems: 4,
                rateInCents: 1234,
                effectiveFrom: effectiveFrom.toISOString(),
                effectiveTo: effectiveTo.toISOString(),
                reason: 'Tarifa de prueba local reversible',
              };
              const rate = await service.createShippingRate(input, actor);
              rateId = rate.id;
              await expect(
                service.createShippingRate(
                  { ...input, rateInCents: 1500 },
                  actor,
                ),
              ).rejects.toBeInstanceOf(ConflictException);
              const day = await service.upsertCalendarDay(
                {
                  date: '2400-01-01',
                  isWorkingDay: false,
                  description: `TEST-${suffix}`,
                  reason: 'Calendario de prueba local reversible',
                },
                actor,
              );
              expect(
                await transaction.shippingRate.count({ where: { id: rateId } }),
              ).toBe(1);
              expect(
                await transaction.auditLog.count({
                  where: {
                    entityType: 'shipping_rate',
                    entityId: rateId,
                    action: 'SHIPPING_RATE_CREATED',
                  },
                }),
              ).toBe(1);
              expect(
                await transaction.logisticsCalendar.count({
                  where: { date: day.date },
                }),
              ).toBe(1);
              throw rollback;
            },
            { timeout: 30000 },
          ),
        ).rejects.toThrow(rollback.message);
        expect(
          await database.shippingRate.count({ where: { id: rateId } }),
        ).toBe(0);
        expect(
          await database.logisticsCalendar.count({
            where: { date: calendarDate },
          }),
        ).toBe(0);
      } finally {
        await database.$disconnect();
      }
    },
    40000,
  );

  it.skipIf(process.env.RUN_PAYOUT_INTEGRATION !== '1')(
    'persists an audited payout draft once on local PostgreSQL, then rolls back',
    async () => {
      const { readFileSync } = await import('node:fs');
      const { randomUUID } = await import('node:crypto');
      const { parse } = await import('dotenv');
      const { ConfigService } = await import('@nestjs/config');
      const environment = parse(
        readFileSync(new URL('../../.env', import.meta.url)),
      );
      expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
      const database = new PrismaService(new ConfigService(environment));
      const rollback = new Error('Rollback payout draft fixture');
      let payoutId = '';
      try {
        await expect(
          database.$transaction(
            async (transaction) => {
              const admin = await transaction.user.findFirstOrThrow({
                where: {
                  status: 'ACTIVE',
                  roles: { some: { role: { code: 'SUPER_ADMIN' } } },
                },
                select: { id: true },
              });
              const store = await transaction.store.findFirstOrThrow({
                where: { status: 'ACTIVE', deletedAt: null },
                select: { id: true },
              });
              const isolated = new Proxy(transaction, {
                get(target, property) {
                  if (property === '$transaction')
                    return (
                      operation: (
                        client: typeof transaction,
                      ) => Promise<unknown>,
                    ) => operation(transaction);
                  return Reflect.get(target, property);
                },
              });
              const service = new AdminInformationService(
                isolated as unknown as PrismaService,
              );
              const input = {
                requestId: randomUUID(),
                storeId: store.id,
                amountInCents: 12345,
                reason: 'Prueba local de registro de borrador',
              };
              const actor = {
                userId: admin.id,
                roles: ['SUPER_ADMIN'],
              } as AuthenticatedUser;
              const first = await service.registerPayout(input, actor);
              payoutId = first.id;
              const retry = await service.registerPayout(input, actor);
              expect(retry).toEqual(first);
              expect(
                await transaction.payout.count({ where: { id: payoutId } }),
              ).toBe(1);
              expect(
                await transaction.ledgerEntry.count({
                  where: { payoutId },
                }),
              ).toBe(0);
              expect(
                await transaction.auditLog.count({
                  where: {
                    entityType: 'payout',
                    entityId: payoutId,
                    action: 'PAYOUT_DRAFT_REGISTERED',
                  },
                }),
              ).toBe(1);
              throw rollback;
            },
            { timeout: 30000 },
          ),
        ).rejects.toThrow(rollback.message);
        expect(await database.payout.count({ where: { id: payoutId } })).toBe(
          0,
        );
        expect(
          await database.auditLog.count({
            where: {
              entityType: 'payout',
              entityId: payoutId,
              action: 'PAYOUT_DRAFT_REGISTERED',
            },
          }),
        ).toBe(0);
      } finally {
        await database.$disconnect();
      }
    },
    40000,
  );

  it.skipIf(process.env.RUN_LOGISTICS_CONFIG_INTEGRATION !== '1')(
    'creates tariff and calendar entries in a local transaction, then rolls back',
    async () => {
      const { readFileSync } = await import('node:fs');
      const { randomUUID } = await import('node:crypto');
      const { parse } = await import('dotenv');
      const { ConfigService } = await import('@nestjs/config');
      const environment = parse(
        readFileSync(new URL('../../.env', import.meta.url)),
      );
      expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
      const database = new PrismaService(new ConfigService(environment));
      const rollback = new Error('Rollback logistics configuration fixture');
      let rateId = '';
      let calendarDate = new Date('2400-01-01T00:00:00.000Z');
      try {
        await expect(
          database.$transaction(
            async (transaction) => {
              const admin = await transaction.user.findFirstOrThrow({
                where: {
                  status: 'ACTIVE',
                  roles: { some: { role: { code: 'SUPER_ADMIN' } } },
                },
                select: { id: true },
              });
              const isolated = new Proxy(transaction, {
                get(target, property) {
                  if (property === '$transaction')
                    return (
                      operation: (
                        client: typeof transaction,
                      ) => Promise<unknown>,
                    ) => operation(transaction);
                  return Reflect.get(target, property);
                },
              });
              const service = new AdminInformationService(
                isolated as unknown as PrismaService,
              );
              const actor = {
                userId: admin.id,
                roles: ['SUPER_ADMIN'],
              } as AuthenticatedUser;
              const suffix = randomUUID().slice(0, 8);
              const start = new Date(Date.now() + 60000);
              const end = new Date(start.getTime() + 3600000);
              const rate = await service.createShippingRate(
                {
                  zoneType: 'LIMA',
                  district: `TEST-${suffix}`,
                  minItems: 1,
                  maxItems: 4,
                  rateInCents: 1234,
                  effectiveFrom: start.toISOString(),
                  effectiveTo: end.toISOString(),
                  reason: 'Tarifa de prueba local reversible',
                },
                actor,
              );
              rateId = rate.id;
              await expect(
                service.createShippingRate(
                  {
                    zoneType: 'LIMA',
                    district: `test-${suffix}`,
                    minItems: 3,
                    maxItems: 5,
                    rateInCents: 1500,
                    effectiveFrom: start.toISOString(),
                    effectiveTo: end.toISOString(),
                    reason: 'Tarifa superpuesta debe rechazarse',
                  },
                  actor,
                ),
              ).rejects.toBeInstanceOf(ConflictException);
              const calendar = await service.upsertCalendarDay(
                {
                  date: '2400-01-01',
                  isWorkingDay: false,
                  description: `TEST-${suffix}`,
                  reason: 'Calendario de prueba local reversible',
                },
                actor,
              );
              calendarDate = calendar.date;
              expect(
                await transaction.shippingRate.count({ where: { id: rateId } }),
              ).toBe(1);
              expect(
                await transaction.auditLog.count({
                  where: {
                    entityType: 'shipping_rate',
                    entityId: rateId,
                    action: 'SHIPPING_RATE_CREATED',
                  },
                }),
              ).toBe(1);
              expect(
                await transaction.logisticsCalendar.count({
                  where: { date: calendarDate },
                }),
              ).toBe(1);
              throw rollback;
            },
            { timeout: 30000 },
          ),
        ).rejects.toThrow(rollback.message);
        expect(
          await database.shippingRate.count({ where: { id: rateId } }),
        ).toBe(0);
        expect(
          await database.logisticsCalendar.count({
            where: { date: calendarDate },
          }),
        ).toBe(0);
      } finally {
        await database.$disconnect();
      }
    },
    40000,
  );
});
