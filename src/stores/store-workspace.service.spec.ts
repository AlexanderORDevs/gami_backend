import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { UsersService } from '../users/users.service.js';
import { StoreAccessService } from './store-access.service.js';
import { StoreWorkspaceService } from './store-workspace.service.js';
import {
  CreateStoreUserDto,
  StoreInformationResource,
  UpdateStoreMemberDto,
} from './store-workspace.dto.js';

it.skipIf(process.env.RUN_STORE_WORKSPACE_INTEGRATION !== '1')(
  'isolates real HTTP store sessions and delegated accounts, then rolls back all fixtures',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { parse } = await import('dotenv');
    const { ConfigService } = await import('@nestjs/config');
    const { JwtService } = await import('@nestjs/jwt');
    const { Test } = await import('@nestjs/testing');
    const { ValidationPipe } = await import('@nestjs/common');
    const { default: request } = await import('supertest');
    const { PrismaService: Database } =
      await import('../database/prisma.service.js');
    const { AppModule } = await import('../app.module.js');
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const database = new Database(new ConfigService(environment));
    const prefix = `scope-${randomUUID()}`;
    const rollback = new Error('Rollback scoped HTTP fixtures');
    try {
      await expect(
        database.$transaction(
          async (transaction) => {
            const own = await transaction.store.create({
              data: {
                displayName: prefix,
                whatsappNumber: `${prefix.slice(0, 24)}-1`,
              },
            });
            const other = await transaction.store.create({
              data: {
                displayName: `${prefix}-other`,
                whatsappNumber: `${prefix.slice(0, 24)}-2`,
              },
            });
            const operator = await transaction.user.create({
              data: {
                username: prefix,
                displayName: 'Scoped admin fixture',
                passwordHash: 'unused-fixture-hash',
                status: 'ACTIVE',
                mustChangePassword: false,
                storeMemberships: {
                  create: { storeId: own.id, role: 'STORE_ADMIN' },
                },
              },
            });
            const session = await transaction.authSession.create({
              data: {
                userId: operator.id,
                familyId: randomUUID(),
                tokenHash: randomUUID(),
                expiresAt: new Date(Date.now() + 60000),
              },
            });
            const product = await transaction.product.create({
              data: {
                storeId: own.id,
                name: 'Own private catalog fixture',
                category: 'Test',
                garmentType: 'Test',
                unitPriceInCents: 1200,
                status: 'UNDER_REVIEW',
              },
            });
            await transaction.product.create({
              data: {
                storeId: other.id,
                name: 'Other store private fixture',
                category: 'Test',
                garmentType: 'Test',
                unitPriceInCents: 9900,
              },
            });
            const isolated = new Proxy(transaction, {
              get(target, property) {
                if (property === '$transaction')
                  return (
                    operation: (client: typeof transaction) => Promise<unknown>,
                  ) => operation(transaction);
                if (
                  property === 'onModuleInit' ||
                  property === 'onModuleDestroy'
                )
                  return async () => {};
                return Reflect.get(target, property);
              },
            });
            const module = await Test.createTestingModule({
              imports: [AppModule],
            })
              .overrideProvider(Database)
              .useValue(isolated)
              .compile();
            const app = module.createNestApplication({ logger: false });
            app.setGlobalPrefix('api');
            app.useGlobalPipes(
              new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
              }),
            );
            await app.init();
            try {
              const token = await app.get(JwtService).signAsync(
                { sub: operator.id, sid: session.id, type: 'access' },
                {
                  secret: app
                    .get(ConfigService)
                    .getOrThrow<string>('JWT_SECRET'),
                },
              );
              const http = app.getHttpServer();
              const authorization = `Bearer ${token}`;
              const ownBase = `/api/store-workspace/stores/${own.id}`;
              const stores = await request(http)
                .get('/api/store-workspace/stores')
                .set('Authorization', authorization)
                .expect(200);
              expect(
                stores.body.map((store: { id: string }) => store.id),
              ).toEqual([own.id]);
              const catalog = await request(http)
                .get(`${ownBase}/information/products`)
                .set('Authorization', authorization)
                .expect(200);
              expect(
                catalog.body.data.map((row: { id: string }) => row.id),
              ).toEqual([product.id]);
              expect(catalog.body.data[0].status).toBe('UNDER_REVIEW');
              await request(http)
                .get(
                  `/api/store-workspace/stores/${other.id}/information/products`,
                )
                .set('Authorization', authorization)
                .expect(403);
              await request(http)
                .get('/api/admin/users')
                .set('Authorization', authorization)
                .expect(403);
              await request(http)
                .post('/api/admin/users')
                .set('Authorization', authorization)
                .send({})
                .expect(403);
              await request(http)
                .post(`/api/admin/users/${operator.id}/roles`)
                .set('Authorization', authorization)
                .send({ roleCode: 'SUPER_ADMIN', reason: 'Escalation fixture' })
                .expect(403);
              await request(http)
                .patch(`${ownBase}/members/${operator.id}`)
                .set('Authorization', authorization)
                .send({
                  role: 'STORE_OPERATOR',
                  active: true,
                  reason: 'Last admin fixture',
                })
                .expect(400);
              const input = {
                username: `${prefix}-new`,
                displayName: 'Delegated admin fixture',
                email: `${prefix}@example.com`,
                storeRole: 'STORE_ADMIN',
              };
              await request(http)
                .post(`${ownBase}/members`)
                .set('Authorization', authorization)
                .send({ ...input, storeRole: 'SUPER_ADMIN' })
                .expect(400);
              await request(http)
                .post(`${ownBase}/members`)
                .set('Authorization', authorization)
                .send({ ...input, storeId: other.id })
                .expect(400);
              const created = await request(http)
                .post(`${ownBase}/members`)
                .set('Authorization', authorization)
                .send(input)
                .expect(201);
              const user = await transaction.user.findUniqueOrThrow({
                where: { id: created.body.userId },
                include: {
                  roles: { include: { role: true } },
                  storeMemberships: true,
                },
              });
              expect(user.roles.map(({ role }) => role.code)).toEqual([
                'STORE_OPERATOR',
              ]);
              expect(user.storeMemberships).toHaveLength(1);
              expect(user.storeMemberships[0]).toMatchObject({
                storeId: own.id,
                role: 'STORE_ADMIN',
              });
              await request(http)
                .patch(`${ownBase}/members/${user.id}`)
                .set('Authorization', authorization)
                .send({
                  role: 'STORE_CATALOG',
                  active: true,
                  reason: 'Delegate catalog fixture',
                })
                .expect(200);
              await transaction.storeMember.update({
                where: {
                  userId_storeId: { userId: operator.id, storeId: own.id },
                },
                data: { role: 'STORE_CATALOG' },
              });
              await request(http)
                .get(`${ownBase}/information/products`)
                .set('Authorization', authorization)
                .expect(200);
              await request(http)
                .get(`${ownBase}/members`)
                .set('Authorization', authorization)
                .expect(403);
              await request(http)
                .get(`${ownBase}/information/ledger`)
                .set('Authorization', authorization)
                .expect(403);
              await transaction.storeMember.update({
                where: {
                  userId_storeId: { userId: operator.id, storeId: own.id },
                },
                data: { active: false },
              });
              await request(http)
                .get(`${ownBase}/information/products`)
                .set('Authorization', authorization)
                .expect(403);
            } finally {
              await app.close();
            }
            throw rollback;
          },
          { timeout: 60000 },
        ),
      ).rejects.toBe(rollback);
      expect(
        await database.user.count({
          where: { username: { startsWith: prefix } },
        }),
      ).toBe(0);
      expect(
        await database.store.count({
          where: { displayName: { startsWith: prefix } },
        }),
      ).toBe(0);
    } finally {
      await database.$disconnect();
    }
  },
  60000,
);

const actor: AuthenticatedUser = {
  userId: 'actor',
  sessionId: 'session',
  username: 'admin',
  displayName: 'Store admin',
  roles: ['STORE_OPERATOR'],
  storeIds: ['own-store'],
  mustChangePassword: false,
};
const query = { page: 1, search: 'shirt' };

describe('StoreWorkspaceService', () => {
  it.each([
    ['products', 'product', { storeId: 'own-store', deletedAt: null }],
    [
      'inventory',
      'variant',
      { product: { storeId: 'own-store', deletedAt: null } },
    ],
    ['orders', 'storeOrder', { storeId: 'own-store' }],
    [
      'shipments',
      'shipment',
      {
        order: expect.objectContaining({
          storeOrders: { some: { storeId: 'own-store' } },
        }),
      },
    ],
    ['payouts', 'payout', { storeId: 'own-store' }],
    ['ledger', 'ledgerEntry', { storeId: 'own-store' }],
  ] as const)(
    'scopes both rows and counts for %s',
    async (resource, model, scope) => {
      const databaseModel = {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      };
      const access = { require: vi.fn().mockResolvedValue('STORE_ADMIN') };
      const service = new StoreWorkspaceService(
        { [model]: databaseModel } as unknown as PrismaService,
        access as unknown as StoreAccessService,
        {} as UsersService,
      );
      await expect(
        service.information(
          'own-store',
          resource as StoreInformationResource,
          query,
          actor,
        ),
      ).resolves.toEqual({ data: [], total: 0, page: 1, pages: 0 });
      expect(access.require).toHaveBeenCalledWith('own-store', actor, resource);
      expect(databaseModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(scope) }),
      );
      expect(databaseModel.count).toHaveBeenCalledWith({
        where: expect.objectContaining(scope),
      });
    },
  );

  it('stops before reading data when another store is requested', async () => {
    const findMany = vi.fn();
    const service = new StoreWorkspaceService(
      { product: { findMany } } as unknown as PrismaService,
      {
        require: vi.fn().mockRejectedValue(new ForbiddenException()),
      } as unknown as StoreAccessService,
      {} as UsersService,
    );
    await expect(
      service.information(
        'other-store',
        StoreInformationResource.products,
        query,
        actor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns only this store subtotal and items for a shared order', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'store-order',
        subtotalInCents: 1200,
        order: { orderNumber: 'GAMI-1' },
        items: [
          {
            productName: 'Own shirt',
            sizeLabel: 'M',
            color: 'Red',
            quantity: 2,
          },
        ],
      },
    ]);
    const service = new StoreWorkspaceService(
      {
        storeOrder: { findMany, count: vi.fn().mockResolvedValue(1) },
      } as unknown as PrismaService,
      { require: vi.fn() } as unknown as StoreAccessService,
      {} as UsersService,
    );
    const result = await service.information(
      'own-store',
      StoreInformationResource.orders,
      query,
      actor,
    );
    expect(result.data[0]).toMatchObject({
      totalInCents: 1200,
      stores: 1,
      items: 'Own shirt / M / Red x 2',
    });
    expect(findMany.mock.calls[0][0].select.order).toEqual({
      select: { orderNumber: true },
    });
  });

  it('rejects global roles and injected scope in store creation DTOs', async () => {
    const input = plainToInstance(CreateStoreUserDto, {
      username: 'operator',
      displayName: 'Operator',
      email: 'operator@example.com',
      storeRole: 'SUPER_ADMIN',
      storeId: 'other-store',
      roles: ['SUPER_ADMIN'],
      isOwner: true,
    });
    const errors = await validate(input, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property).sort()).toEqual([
      'isOwner',
      'roles',
      'storeId',
      'storeRole',
    ]);
    const change = plainToInstance(UpdateStoreMemberDto, {
      role: 'SUPER_ADMIN',
      active: true,
      reason: 'Privilege escalation',
    });
    expect((await validate(change)).map((error) => error.property)).toContain(
      'role',
    );
  });

  it('creates another store administrator with only the route store and no global roles', async () => {
    const transaction = { $executeRaw: vi.fn() };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    };
    const access = { require: vi.fn().mockResolvedValue('STORE_ADMIN') };
    const users = {
      create: vi.fn().mockResolvedValue({
        user: { id: 'new-member' },
        temporaryPassword: 'test-only',
      }),
    };
    const service = new StoreWorkspaceService(
      prisma as unknown as PrismaService,
      access as unknown as StoreAccessService,
      users as unknown as UsersService,
    );
    await expect(
      service.createMember(
        'own-store',
        {
          username: 'new.admin',
          displayName: 'New admin',
          email: 'new@example.com',
          storeRole: 'STORE_ADMIN',
        },
        actor,
        {},
      ),
    ).resolves.toEqual({
      userId: 'new-member',
      temporaryPassword: 'test-only',
    });
    expect(users.create).toHaveBeenCalledWith(
      {
        username: 'new.admin',
        displayName: 'New admin',
        email: 'new@example.com',
        phone: undefined,
        storeId: 'own-store',
        storeRole: 'STORE_ADMIN',
      },
      actor,
      {},
      transaction,
    );
    expect(access.require).toHaveBeenCalledWith(
      'own-store',
      actor,
      'members',
      transaction,
    );
  });

  it.each(['last-admin', 'foreign-member', 'revoked-actor'])(
    'blocks unsafe member changes: %s',
    async (scenario) => {
      const transaction = {
        $executeRaw: vi.fn(),
        storeMember: {
          findFirst: vi
            .fn()
            .mockResolvedValue(
              scenario === 'foreign-member'
                ? null
                : { role: 'STORE_ADMIN', active: true },
            ),
          count: vi.fn().mockResolvedValue(0),
          update: vi.fn(),
        },
      };
      const access = {
        require:
          scenario === 'revoked-actor'
            ? vi.fn().mockRejectedValue(new ForbiddenException())
            : vi.fn(),
      };
      const service = new StoreWorkspaceService(
        {
          $transaction: async (
            operation: (client: typeof transaction) => Promise<unknown>,
          ) => operation(transaction),
        } as unknown as PrismaService,
        access as unknown as StoreAccessService,
        {} as UsersService,
      );
      const expected =
        scenario === 'last-admin'
          ? BadRequestException
          : scenario === 'foreign-member'
            ? NotFoundException
            : ForbiddenException;
      await expect(
        service.updateMember(
          'own-store',
          'target',
          { role: 'STORE_OPERATOR', active: false, reason: 'Remove access' },
          actor,
          {},
        ),
      ).rejects.toBeInstanceOf(expected);
      expect(transaction.storeMember.update).not.toHaveBeenCalled();
    },
  );
});
