import { PrismaService } from '../database/prisma.service.js';
import { AdminInformationService } from './admin-information.service.js';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import { AdminInformationController } from './admin-information.controller.js';

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
      'ledger',
      'settings',
      'calendar',
      'shippingRates',
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
});
