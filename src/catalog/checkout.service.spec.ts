import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckoutOrderDto, CheckoutQuoteDto } from './checkout.dto.js';

const variantId = 'ab9d0102-794e-4d6b-9185-000000000001';
const addressInput = {
  customerName: 'Cliente de prueba',
  customerPhone: '999888777',
  recipientName: 'Destinatario de prueba',
  recipientPhone: '999888777',
  zoneType: 'LIMA',
  city: 'Lima',
  district: 'La Victoria',
  line1: 'Av. Prueba 123',
};
describe('checkout input', () => {
  it('rejects injected totals, store scope and duplicate variants', async () => {
    const options = { whitelist: true, forbidNonWhitelisted: true };
    const input = {
      items: [{ variantId, quantity: 1 }],
      zoneType: 'LIMA',
      district: 'La Victoria',
    };
    expect(
      await validate(plainToInstance(CheckoutQuoteDto, input), options),
    ).toHaveLength(0);
    for (const patch of [
      { shippingInCents: 0 },
      { storeId: variantId },
      { items: [] },
      { items: [...input.items, ...input.items] },
      { items: [{ variantId, quantity: 0 }] },
    ]) {
      expect(
        (
          await validate(
            plainToInstance(CheckoutQuoteDto, { ...input, ...patch }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });
  it('requires full delivery details and idempotency on order creation', async () => {
    const input = {
      ...addressInput,
      items: [{ variantId, quantity: 1 }],
      requestId: variantId,
      expectedSubtotalInCents: 1000,
      expectedShippingInCents: 100,
    };
    expect(
      await validate(plainToInstance(CheckoutOrderDto, input)),
    ).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(CheckoutOrderDto, {
            ...input,
            requestId: undefined,
            line1: '',
            customerPhone: 'invalid',
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});

it.skipIf(process.env.RUN_CHECKOUT_INTEGRATION !== '1')(
  'creates a real two-store pending order, checks tariff and stock, replays safely, then rolls back',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { parse } = await import('dotenv');
    const { ConfigService } = await import('@nestjs/config');
    const { JwtService } = await import('@nestjs/jwt');
    const { Test } = await import('@nestjs/testing');
    const { ValidationPipe } = await import('@nestjs/common');
    const { ThrottlerGuard } = await import('@nestjs/throttler');
    const { default: request } = await import('supertest');
    const { PrismaService } = await import('../database/prisma.service.js');
    const { AppModule } = await import('../app.module.js');
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const database = new PrismaService(new ConfigService(environment));
    const prefix = `checkout-${randomUUID()}`;
    const rollback = new Error('Rollback checkout fixtures');
    try {
      await expect(
        database.$transaction(
          async (transaction) => {
            const stores = [];
            const variants = [];
            for (const index of [1, 2]) {
              const store = await transaction.store.create({
                data: {
                  displayName: `${prefix}-${index}`,
                  whatsappNumber: `${prefix.slice(0, 23)}-${index}`,
                  status: 'ACTIVE',
                },
              });
              stores.push(store);
              const product = await transaction.product.create({
                data: {
                  storeId: store.id,
                  name: `${prefix}-${index}`,
                  category: 'Test',
                  garmentType: 'Test',
                  unitPriceInCents: index * 1000,
                  status: 'PUBLISHED',
                  variants: {
                    create: {
                      sku: `${prefix}-${index}`,
                      sizeNormalized: 'M',
                      sizeLabel: 'M',
                      color: 'Azul',
                      inventory: { create: { quantity: 5 } },
                    },
                  },
                },
                include: { variants: true },
              });
              variants.push(product.variants[0]);
            }
            const customerRole = await transaction.role.findUniqueOrThrow({
              where: { code: 'CUSTOMER' },
            });
            const client = await transaction.user.create({
              data: {
                username: prefix,
                displayName: 'Checkout fixture',
                passwordHash: 'unused',
                roles: { create: { roleId: customerRole.id } },
                customer: {
                  create: {
                    fullName: 'Checkout fixture',
                    phone: '999888777',
                    cartItems: {
                      create: variants.map((variant) => ({
                        variantId: variant.id,
                        quantity: 2,
                      })),
                    },
                  },
                },
              },
            });
            const clientSession = await transaction.authSession.create({
              data: {
                userId: client.id,
                familyId: randomUUID(),
                tokenHash: randomUUID(),
                expiresAt: new Date(Date.now() + 120000),
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
              .overrideProvider(PrismaService)
              .useValue(isolated)
              .overrideGuard(ThrottlerGuard)
              .useValue({ canActivate: () => true })
              .compile();
            const app = module.createNestApplication({ logger: false });
            const token = await module
              .get(JwtService)
              .signAsync(
                { sub: client.id, sid: clientSession.id, type: 'access' },
                { secret: environment.JWT_SECRET },
              );
            app.use(
              (
                req: { headers: Record<string, string> },
                _res: unknown,
                next: () => void,
              ) => {
                req.headers.authorization = `Bearer ${token}`;
                next();
              },
            );
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
              const http = app.getHttpServer();
              const district = prefix.slice(0, 60);
              const quoteInput = {
                items: variants.map((variant) => ({
                  variantId: variant.id,
                  quantity: 2,
                })),
                zoneType: 'LIMA',
                district,
              };
              await transaction.shippingRate.updateMany({
                where: { zoneType: 'LIMA' },
                data: { active: false },
              });
              await request(http)
                .post('/api/checkout/quote')
                .send(quoteInput)
                .expect(409);
              const rate = await transaction.shippingRate.create({
                data: {
                  zoneType: 'LIMA',
                  district,
                  minItems: 1,
                  maxItems: 10,
                  rateInCents: 1500,
                  effectiveFrom: new Date(Date.now() - 60000),
                },
              });
              const destinations = await request(http)
                .get('/api/checkout/destinations')
                .expect(200);
              expect(destinations.body.destinations).toContainEqual({
                zoneType: 'LIMA',
                district,
              });
              const quote = await request(http)
                .post('/api/checkout/quote')
                .send(quoteInput)
                .expect(201);
              expect(quote.body).toMatchObject({
                subtotalInCents: 6000,
                shippingInCents: 1500,
                totalInCents: 7500,
              });
              const orderInput = {
                ...addressInput,
                ...quoteInput,
                customerName: prefix,
                requestId: randomUUID(),
                expectedSubtotalInCents: 6000,
                expectedShippingInCents: 1500,
              };
              await request(http)
                .post('/api/checkout/orders')
                .send({ ...orderInput, totalInCents: 1 })
                .expect(400);
              await request(http)
                .post('/api/checkout/orders')
                .send({ ...orderInput, expectedSubtotalInCents: 1 })
                .expect(409);
              expect(
                await transaction.customer.count({
                  where: { fullName: prefix },
                }),
              ).toBe(0);
              const created = await request(http)
                .post('/api/checkout/orders')
                .send(orderInput)
                .expect(201);
              expect(created.body).toMatchObject({
                status: 'PENDING_PAYMENT',
                totalInCents: 7500,
              });
              const order = await transaction.order.findUniqueOrThrow({
                where: { orderNumber: created.body.orderNumber },
                include: {
                  storeOrders: { include: { items: true } },
                  stockHolds: true,
                  payment: true,
                },
              });
              expect(order.storeOrders).toHaveLength(2);
              expect(
                order.storeOrders
                  .map((row) => row.subtotalInCents)
                  .sort((left, right) => left - right),
              ).toEqual([2000, 4000]);
              expect(order.stockHolds).toHaveLength(2);
              expect(
                order.stockHolds.every(
                  (hold) => hold.status === 'LIVE' && hold.quantity === 2,
                ),
              ).toBe(true);
              expect(order.payment).toBeNull();
              const replay = await request(http)
                .post('/api/checkout/orders')
                .send(orderInput)
                .expect(201);
              expect(replay.body).toEqual(created.body);
              expect(
                await transaction.order.count({
                  where: { customer: { userId: client.id } },
                }),
              ).toBe(1);
              await request(http)
                .post('/api/checkout/orders')
                .send({ ...orderInput, line1: 'Otra direccion' })
                .expect(409);
              await request(http)
                .post('/api/checkout/quote')
                .send({
                  ...quoteInput,
                  items: [{ variantId: variants[0].id, quantity: 4 }],
                })
                .expect(409);
              await transaction.stockHold.updateMany({
                where: { orderId: order.id },
                data: { expiresAt: new Date(Date.now() - 60000) },
              });
              await request(http)
                .post('/api/checkout/quote')
                .send({
                  ...quoteInput,
                  items: [{ variantId: variants[0].id, quantity: 5 }],
                })
                .expect(201);
              await transaction.store.update({
                where: { id: stores[1].id },
                data: { status: 'SUSPENDED' },
              });
              await request(http)
                .post('/api/checkout/quote')
                .send(quoteInput)
                .expect(409);
              await transaction.store.update({
                where: { id: stores[1].id },
                data: { status: 'ACTIVE' },
              });
              await transaction.shippingRate.create({
                data: {
                  zoneType: 'LIMA',
                  district,
                  rateInCents: 1600,
                  effectiveFrom: new Date(Date.now() - 60000),
                },
              });
              await request(http)
                .post('/api/checkout/quote')
                .send(quoteInput)
                .expect(409);
              expect(
                await transaction.auditLog.count({
                  where: {
                    entityId: order.id,
                    action: 'CHECKOUT_ORDER_CREATED',
                  },
                }),
              ).toBe(1);
              expect(
                await transaction.inventory.findUniqueOrThrow({
                  where: { variantId: variants[0].id },
                }),
              ).toMatchObject({ quantity: 5 });
              expect(rate.active).toBe(true);
            } finally {
              await app.close();
            }
            throw rollback;
          },
          { timeout: 90000 },
        ),
      ).rejects.toThrow(rollback.message);
      expect(
        await database.store.count({
          where: { displayName: { startsWith: prefix } },
        }),
      ).toBe(0);
    } finally {
      await database.$disconnect();
    }
  },
  100000,
);

it.skipIf(process.env.RUN_CHECKOUT_INTEGRATION !== '1')(
  'serializes competing last-unit checkouts and simultaneous retries in a disposable local database',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { spawnSync } = await import('node:child_process');
    const { parse } = await import('dotenv');
    const { Client } = await import('pg');
    const { ConfigService } = await import('@nestjs/config');
    const { PrismaService } = await import('../database/prisma.service.js');
    const { CheckoutService } = await import('./checkout.service.js');
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const databaseName = `checkout_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const admin = new Client({
      host: environment.DB_HOST,
      port: Number(environment.DB_PORT),
      user: environment.DB_USER,
      password: environment.DB_PASSWORD,
      database: environment.DB_NAME,
    });
    const nativeEnvironment = {
      ...process.env,
      PGHOST: environment.DB_HOST,
      PGPORT: environment.DB_PORT,
      PGUSER: environment.DB_USER,
      PGPASSWORD: environment.DB_PASSWORD,
      PGSSLMODE: 'disable',
      PGDATABASE: environment.DB_NAME,
    };
    let created = false;
    const prisma = new PrismaService(
      new ConfigService({ ...environment, DB_NAME: databaseName }),
    );
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const schema = spawnSync(
        String.raw`C:\Program Files\PostgreSQL\18\bin\pg_dump.exe`,
        [
          '--schema-only',
          '--schema=public',
          '--no-owner',
          '--no-privileges',
          '--no-password',
        ],
        { env: nativeEnvironment, encoding: 'utf8' },
      );
      expect(schema.status).toBe(0);
      const restore = spawnSync(
        String.raw`C:\Program Files\PostgreSQL\18\bin\psql.exe`,
        [
          '--no-psqlrc',
          '--no-password',
          '--single-transaction',
          '--set=ON_ERROR_STOP=on',
          '--command=DROP SCHEMA public CASCADE;',
          '--file',
          '-',
        ],
        {
          env: { ...nativeEnvironment, PGDATABASE: databaseName },
          input: schema.stdout,
          encoding: 'utf8',
        },
      );
      expect(restore.status).toBe(0);
      const store = await prisma.store.create({
        data: {
          displayName: 'Concurrency fixture',
          whatsappNumber: 'test-concurrency',
          status: 'ACTIVE',
        },
      });
      const product = await prisma.product.create({
        data: {
          storeId: store.id,
          name: 'Last unit',
          category: 'Test',
          garmentType: 'Test',
          unitPriceInCents: 1000,
          status: 'PUBLISHED',
          variants: {
            create: {
              sku: randomUUID(),
              sizeLabel: 'M',
              sizeNormalized: 'M',
              color: 'Azul',
              inventory: { create: { quantity: 1 } },
            },
          },
        },
        include: { variants: true },
      });
      await prisma.shippingRate.create({
        data: {
          zoneType: 'LIMA',
          district: 'La Victoria',
          rateInCents: 100,
          effectiveFrom: new Date(Date.now() - 60000),
        },
      });
      const { CustomersService } =
        await import('../customers/customers.service.js');
      const customers = new CustomersService(
        prisma,
        {} as ConstructorParameters<typeof CustomersService>[1],
      );
      const service = new CheckoutService(prisma, customers);
      const role = await prisma.role.create({
        data: { code: 'CUSTOMER', name: 'Client' },
      });
      const principals = [];
      for (const suffix of ['a', 'b']) {
        const user = await prisma.user.create({
          data: {
            username: `concurrent-${suffix}`,
            displayName: 'Concurrent client',
            passwordHash: 'unused',
            roles: { create: { roleId: role.id } },
            customer: {
              create: {
                fullName: 'Concurrent client',
                phone: '999888777',
                cartItems: {
                  create: { variantId: product.variants[0].id, quantity: 1 },
                },
              },
            },
          },
        });
        principals.push({
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
          sessionId: randomUUID(),
          roles: ['CUSTOMER'],
          storeIds: [],
          mustChangePassword: false,
        });
      }
      const input = {
        ...addressInput,
        zoneType: 'LIMA' as const,
        items: [{ variantId: product.variants[0].id, quantity: 1 }],
        expectedSubtotalInCents: 1000,
        expectedShippingInCents: 100,
        requestId: randomUUID(),
      };
      const competing = await Promise.allSettled([
        service.create(input, principals[0]),
        service.create({ ...input, requestId: randomUUID() }, principals[1]),
      ]);
      expect(
        competing.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        competing.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.stockHold.count()).toBe(1);
      const fulfilled = competing.find(
        (result) => result.status === 'fulfilled',
      );
      if (fulfilled?.status !== 'fulfilled')
        throw new Error('Expected one successful checkout');
      const event = await prisma.integrationEvent.findFirstOrThrow({
        where: { provider: 'PUBLIC_CHECKOUT' },
      });
      const owner = principals.find((principal) =>
        event.externalEventId.startsWith(`${principal.userId}:`),
      )!;
      const original = {
        ...input,
        requestId: event.externalEventId.split(':')[1],
      };
      const retries = await Promise.all([
        service.create(original, owner),
        service.create(original, owner),
      ]);
      expect(retries[0]).toEqual(fulfilled.value);
      expect(retries[1]).toEqual(fulfilled.value);
      expect(await prisma.order.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
      if (created)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
  100000,
);
