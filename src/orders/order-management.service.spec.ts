import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { hasVerifiedPayment } from './order-management.service.js';
import {
  ConfirmStoreOrderDto,
  ReportOrderIncidentDto,
} from './order-management.dto.js';

it('requires captured payment evidence with matching amount and currency', () => {
  const payment = {
    status: 'CAPTURED',
    amountInCents: 5000,
    currency: 'PEN',
    capturedAt: new Date(),
  };
  expect(
    hasVerifiedPayment({ totalInCents: 5000, currency: 'PEN', payment }),
  ).toBe(true);
  for (const patch of [
    { status: 'PENDING' },
    { amountInCents: 1 },
    { currency: 'USD' },
    { capturedAt: null },
  ])
    expect(
      hasVerifiedPayment({
        totalInCents: 5000,
        currency: 'PEN',
        payment: { ...payment, ...patch },
      }),
    ).toBe(false);
  expect(
    hasVerifiedPayment({ totalInCents: 5000, currency: 'PEN', payment: null }),
  ).toBe(false);
});

it('validates versioned confirmation and affected-item contracts without arbitrary state changes', async () => {
  const input = {
    expectedUpdatedAt: new Date().toISOString(),
    reason: 'Disponibilidad verificada',
    items: [
      {
        orderItemId: 'ab9d0102-794e-4d6b-9185-000000000001',
        confirmedQuantity: 1,
      },
    ],
  };
  const options = { whitelist: true, forbidNonWhitelisted: true };
  expect(
    await validate(plainToInstance(ConfirmStoreOrderDto, input), options),
  ).toHaveLength(0);
  for (const patch of [
    { status: 'DELIVERED' },
    { reason: 'x'.repeat(256) },
    { items: [] },
    { expectedUpdatedAt: 'bad' },
    { items: [{ ...input.items[0], confirmedQuantity: -1 }] },
    { items: [...input.items, ...input.items] },
  ])
    expect(
      (
        await validate(
          plainToInstance(ConfirmStoreOrderDto, { ...input, ...patch }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  expect(
    (
      await validate(
        plainToInstance(ReportOrderIncidentDto, {
          ...input,
          requestId: input.items[0].orderItemId,
          type: 'REFUND',
          items: [{ orderItemId: input.items[0].orderItemId, quantity: 1 }],
        }),
        options,
      )
    ).length,
  ).toBeGreaterThan(0);
});

it.skipIf(process.env.RUN_ORDER_MANAGEMENT_INTEGRATION !== '1')(
  'isolates order detail and confirms paid store quantities with incidents and audited recounted stock, then rolls back',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { parse } = await import('dotenv');
    const { ConfigService } = await import('@nestjs/config');
    const { JwtService } = await import('@nestjs/jwt');
    const { Test } = await import('@nestjs/testing');
    const { ValidationPipe } = await import('@nestjs/common');
    const { default: request } = await import('supertest');
    const { PrismaService } = await import('../database/prisma.service.js');
    const { AppModule } = await import('../app.module.js');
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const database = new PrismaService(new ConfigService(environment));
    const prefix = `order-flow-${randomUUID()}`;
    const rollback = new Error('Rollback order-management fixtures');
    try {
      await expect(
        database.$transaction(
          async (transaction) => {
            const customerRole = await transaction.role.findUniqueOrThrow({
              where: { code: 'CUSTOMER' },
            });
            const adminRole = await transaction.role.findUniqueOrThrow({
              where: { code: 'SUPER_ADMIN' },
            });
            const customers = [];
            for (const suffix of ['a', 'b'])
              customers.push(
                await transaction.user.create({
                  data: {
                    username: `${prefix}-${suffix}`,
                    displayName: 'Private buyer fixture',
                    passwordHash: 'unused',
                    roles: { create: { roleId: customerRole.id } },
                    customer: {
                      create: {
                        fullName: 'PRIVATE BUYER',
                        email: 'private-buyer@example.com',
                        phone: '999888777',
                        addresses: {
                          create: {
                            recipientName: 'PRIVATE RECIPIENT',
                            recipientPhone: '999888777',
                            zoneType: 'LIMA',
                            city: 'Lima',
                            line1: 'PRIVATE DELIVERY ADDRESS',
                          },
                        },
                      },
                    },
                  },
                  include: { customer: { include: { addresses: true } } },
                }),
              );
            const admin = await transaction.user.create({
              data: {
                username: `${prefix}-admin`,
                displayName: 'Admin fixture',
                passwordHash: 'unused',
                roles: { create: { roleId: adminRole.id } },
              },
            });
            const stores = [];
            const staff = [];
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
              staff.push(
                await transaction.user.create({
                  data: {
                    username: `${prefix}-staff-${index}`,
                    displayName: 'Store fixture',
                    passwordHash: 'unused',
                    storeMemberships: {
                      create: { storeId: store.id, role: 'STORE_ADMIN' },
                    },
                  },
                }),
              );
              const product = await transaction.product.create({
                data: {
                  storeId: store.id,
                  name: `Own store item ${index}`,
                  category: 'Test',
                  garmentType: 'Test',
                  unitPriceInCents: index === 1 ? 1500 : 2000,
                  status: 'PUBLISHED',
                  variants: {
                    create: {
                      sku: `${prefix}-${index}`,
                      sizeNormalized: 'M',
                      sizeLabel: 'M',
                      color: 'Azul',
                      inventory: { create: { quantity: 20 } },
                    },
                  },
                },
                include: { variants: true },
              });
              variants.push(product.variants[0]);
            }
            async function makeOrder(paid: boolean) {
              const order = await transaction.order.create({
                data: {
                  orderNumber: `T-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
                  customerId: customers[0].customer!.id,
                  shippingAddressId: customers[0].customer!.addresses[0].id,
                  subtotalInCents: 9000,
                  shippingInCents: 500,
                  totalInCents: 9500,
                  status: paid ? 'PAID' : 'PENDING_PAYMENT',
                  ...(paid
                    ? {
                        payment: {
                          create: {
                            provider: 'LOCAL_TEST_ONLY',
                            idempotencyKey: randomUUID(),
                            status: 'CAPTURED' as const,
                            amountInCents: 9500,
                            capturedAt: new Date(),
                          },
                        },
                      }
                    : {}),
                  storeOrders: {
                    create: stores.map((store, index) => ({
                      storeId: store.id,
                      subtotalInCents: index === 0 ? 3000 : 6000,
                      items: {
                        create: {
                          variantId: variants[index].id,
                          productName: `Own store item ${index + 1}`,
                          sku: variants[index].sku,
                          sizeLabel: 'M',
                          color: 'Azul',
                          quantity: index === 0 ? 2 : 3,
                          unitPriceInCents: index === 0 ? 1500 : 2000,
                          totalInCents: index === 0 ? 3000 : 6000,
                        },
                      },
                    })),
                  },
                },
                include: { storeOrders: { include: { items: true } } },
              });
              for (const suborder of order.storeOrders)
                for (const item of suborder.items)
                  await transaction.stockHold.create({
                    data: {
                      variantId: item.variantId,
                      orderId: order.id,
                      orderItemId: item.id,
                      quantity: item.quantity,
                      status: paid ? 'FIRM' : 'LIVE',
                      ...(paid
                        ? { firmedAt: new Date() }
                        : { expiresAt: new Date(Date.now() + 600000) }),
                    },
                  });
              return order;
            }
            const paid = await makeOrder(true);
            const pending = await makeOrder(false);
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
              const http = app.getHttpServer();
              const tokens = [];
              for (const user of [...customers, admin, ...staff]) {
                const session = await transaction.authSession.create({
                  data: {
                    userId: user.id,
                    familyId: randomUUID(),
                    tokenHash: randomUUID(),
                    expiresAt: new Date(Date.now() + 120000),
                  },
                });
                tokens.push(
                  `Bearer ${await app.get(JwtService).signAsync({ sub: user.id, sid: session.id, type: 'access' }, { secret: environment.JWT_SECRET })}`,
                );
              }
              const [
                customerToken,
                foreignToken,
                adminToken,
                storeToken,
                secondStoreToken,
              ] = tokens;
              const detailPath = `/api/order-management/orders/${paid.orderNumber}`;
              await request(http).get(detailPath).expect(401);
              await request(http)
                .get(detailPath)
                .set('Authorization', foreignToken)
                .expect(404);
              const storeDetail = (
                await request(http)
                  .get(detailPath)
                  .set('Authorization', storeToken)
                  .expect(200)
              ).body;
              expect(storeDetail.suborders).toHaveLength(1);
              expect(storeDetail.totalInCents).toBe(3000);
              expect(storeDetail.shippingInCents).toBeNull();
              expect(storeDetail.customer).toBeNull();
              expect(JSON.stringify(storeDetail)).not.toContain('PRIVATE');
              expect(JSON.stringify(storeDetail)).not.toContain(
                'Own store item 2',
              );
              expect(storeDetail.suborders[0].canConfirm).toBe(true);
              const own = storeDetail.suborders[0];
              const item = own.items[0];
              const input = {
                expectedUpdatedAt: own.updatedAt,
                reason: 'Una unidad no esta disponible',
                items: [{ orderItemId: item.id, confirmedQuantity: 1 }],
              };
              const other = paid.storeOrders.find(
                (row) => row.storeId === stores[1].id,
              )!;
              await request(http)
                .post(`/api/order-management/store-orders/${other.id}/confirm`)
                .set('Authorization', storeToken)
                .send({
                  ...input,
                  items: [
                    { orderItemId: other.items[0].id, confirmedQuantity: 3 },
                  ],
                })
                .expect(403);
              await request(http)
                .post(`/api/order-management/store-orders/${own.id}/confirm`)
                .set('Authorization', customerToken)
                .send(input)
                .expect(403);
              await request(http)
                .post(`/api/order-management/store-orders/${own.id}/confirm`)
                .set('Authorization', storeToken)
                .send({ ...input, status: 'DELIVERED' })
                .expect(400);
              await request(http)
                .post(`/api/order-management/store-orders/${own.id}/confirm`)
                .set('Authorization', storeToken)
                .send({ ...input, expectedUpdatedAt: '2020-01-01T00:00:00Z' })
                .expect(409);
              await request(http)
                .post(`/api/order-management/store-orders/${own.id}/confirm`)
                .set('Authorization', storeToken)
                .send({
                  ...input,
                  items: [{ orderItemId: item.id, confirmedQuantity: 3 }],
                })
                .expect(400);
              const pendingOwn = pending.storeOrders.find(
                (row) => row.storeId === stores[0].id,
              )!;
              await request(http)
                .post(
                  `/api/order-management/store-orders/${pendingOwn.id}/confirm`,
                )
                .set('Authorization', storeToken)
                .send({
                  ...input,
                  expectedUpdatedAt: pendingOwn.updatedAt.toISOString(),
                  items: [
                    {
                      orderItemId: pendingOwn.items[0].id,
                      confirmedQuantity: 2,
                    },
                  ],
                })
                .expect(409);
              await transaction.storeMember.update({
                where: {
                  userId_storeId: {
                    userId: staff[0].id,
                    storeId: stores[0].id,
                  },
                },
                data: { role: 'STORE_LOGISTICS' },
              });
              await request(http)
                .post(`/api/order-management/store-orders/${own.id}/confirm`)
                .set('Authorization', storeToken)
                .send(input)
                .expect(403);
              await transaction.storeMember.update({
                where: {
                  userId_storeId: {
                    userId: staff[0].id,
                    storeId: stores[0].id,
                  },
                },
                data: { role: 'STORE_ADMIN' },
              });
              const confirmed = await request(http)
                .post(`/api/order-management/store-orders/${own.id}/confirm`)
                .set('Authorization', storeToken)
                .send(input)
                .expect(201);
              expect(confirmed.body.status).toBe('PARTIALLY_CONFIRMED');
              expect(
                await transaction.inventory.findUniqueOrThrow({
                  where: { variantId: variants[0].id },
                }),
              ).toMatchObject({ quantity: 19, needsReview: true });
              expect(
                (
                  await transaction.orderItem.findUniqueOrThrow({
                    where: { id: item.id },
                  })
                ).confirmedQuantity,
              ).toBe(1);
              await request(http)
                .post(`/api/order-management/store-orders/${own.id}/confirm`)
                .set('Authorization', storeToken)
                .send(input)
                .expect(409);
              expect(
                await transaction.stockMovement.count({
                  where: { orderItemId: item.id, type: 'SALE' },
                }),
              ).toBe(1);
              expect(
                await transaction.stockHold.count({
                  where: {
                    orderItemId: item.id,
                    status: 'CONSUMED',
                    quantity: 1,
                  },
                }),
              ).toBe(1);
              expect(
                await transaction.stockHold.count({
                  where: { orderItemId: item.id, status: 'FIRM' },
                }),
              ).toBe(0);
              await request(http)
                .put(`/api/customers/me/cart/${variants[0].id}`)
                .set('Authorization', customerToken)
                .send({ quantity: 1 })
                .expect(404);
              const flaggedOptions = (
                await request(http)
                  .get(
                    `/api/store-workspace/stores/${stores[0].id}/order-variants`,
                  )
                  .set('Authorization', storeToken)
                  .expect(200)
              ).body;
              expect(
                flaggedOptions.data.find(
                  (variant: { id: string }) => variant.id === variants[0].id,
                ),
              ).toMatchObject({
                quantity: 19,
                available: 0,
                needsReview: true,
              });
              const flaggedProduct = (
                await request(http)
                  .get(`/api/catalog/products/${variants[0].productId}`)
                  .expect(200)
              ).body;
              expect(flaggedProduct.stockKnown).toBe(false);
              expect(flaggedProduct.variants[0].availableStock).toBe(0);
              const incident =
                await transaction.fulfillmentException.findFirstOrThrow({
                  where: { storeOrderId: own.id },
                });
              expect(incident.type).toBe('OUT_OF_STOCK');
              expect(incident.resolvedAt).toBeNull();
              const review = {
                expectedUpdatedAt: incident.updatedAt.toISOString(),
                note: 'INTERNAL REVIEW NOTE: requiere contacto, sin reembolso ejecutado'.padEnd(
                  1000,
                  '.',
                ),
              };
              await request(http)
                .patch(`/api/order-management/incidents/${incident.id}/review`)
                .set('Authorization', storeToken)
                .send(review)
                .expect(403);
              await request(http)
                .patch(`/api/order-management/incidents/${incident.id}/review`)
                .set('Authorization', adminToken)
                .send(review)
                .expect(200);
              expect(
                (
                  await transaction.fulfillmentException.findUniqueOrThrow({
                    where: { id: incident.id },
                  })
                ).reviewNote,
              ).toBe(review.note);
              await request(http)
                .patch(`/api/order-management/incidents/${incident.id}/review`)
                .set('Authorization', adminToken)
                .send(review)
                .expect(409);
              const customerDetail = (
                await request(http)
                  .get(detailPath)
                  .set('Authorization', customerToken)
                  .expect(200)
              ).body;
              expect(customerDetail.suborders).toHaveLength(2);
              expect(customerDetail.totalInCents).toBe(9500);
              expect(customerDetail.canReviewIncidents).toBe(false);
              expect(JSON.stringify(customerDetail)).not.toContain(
                'INTERNAL REVIEW NOTE',
              );
              expect(
                customerDetail.timeline.some(
                  (event: { action: string }) =>
                    event.action === 'STORE_ORDER_CONFIRMED',
                ),
              ).toBe(true);
              const secondDetail = (
                await request(http)
                  .get(detailPath)
                  .set('Authorization', secondStoreToken)
                  .expect(200)
              ).body.suborders[0];
              await request(http)
                .post(
                  `/api/order-management/store-orders/${secondDetail.id}/confirm`,
                )
                .set('Authorization', secondStoreToken)
                .send({
                  expectedUpdatedAt: secondDetail.updatedAt,
                  reason: 'Disponibilidad completa',
                  items: secondDetail.items.map(
                    (row: { id: string; quantity: number }) => ({
                      orderItemId: row.id,
                      confirmedQuantity: row.quantity,
                    }),
                  ),
                })
                .expect(201);
              expect(
                await transaction.order.findUniqueOrThrow({
                  where: { id: paid.id },
                }),
              ).toMatchObject({
                status: 'PARTIALLY_CONFIRMED',
                totalInCents: 9500,
                subtotalInCents: 9000,
              });
              expect(
                await transaction.payment.findUniqueOrThrow({
                  where: { orderId: paid.id },
                }),
              ).toMatchObject({ status: 'CAPTURED', amountInCents: 9500 });
              const movementsBefore = await transaction.stockMovement.count({
                where: { variantId: variants[0].id },
              });
              await request(http)
                .patch(
                  `/api/store-workspace/stores/${stores[0].id}/inventory/${variants[0].id}`,
                )
                .set('Authorization', storeToken)
                .send({
                  quantity: 19,
                  expectedQuantity: 19,
                  reason:
                    'Recuento fisico confirmado sin variacion de cantidad',
                })
                .expect(200);
              expect(
                await transaction.inventory.findUniqueOrThrow({
                  where: { variantId: variants[0].id },
                }),
              ).toMatchObject({ quantity: 19, needsReview: false });
              expect(
                await transaction.stockMovement.count({
                  where: { variantId: variants[0].id },
                }),
              ).toBe(movementsBefore);
              const currentPending = (
                await request(http)
                  .get(`/api/order-management/orders/${pending.orderNumber}`)
                  .set('Authorization', storeToken)
              ).body.suborders[0];
              const report = {
                requestId: randomUUID(),
                expectedUpdatedAt: currentPending.updatedAt,
                type: 'ITEM_MISMATCH',
                reason: 'Revisar etiqueta de la prenda',
                items: [
                  { orderItemId: currentPending.items[0].id, quantity: 1 },
                ],
              };
              const reported = await request(http)
                .post(
                  `/api/order-management/store-orders/${currentPending.id}/incidents`,
                )
                .set('Authorization', storeToken)
                .send(report)
                .expect(201);
              await request(http)
                .post(
                  `/api/order-management/store-orders/${currentPending.id}/incidents`,
                )
                .set('Authorization', storeToken)
                .send(report)
                .expect(201)
                .expect(reported.body);
              expect(
                await transaction.fulfillmentException.count({
                  where: { storeOrderId: currentPending.id },
                }),
              ).toBe(1);
              await request(http)
                .post(
                  `/api/order-management/store-orders/${currentPending.id}/incidents`,
                )
                .set('Authorization', storeToken)
                .send({ ...report, reason: 'Una solicitud diferente' })
                .expect(409);
              expect(
                await transaction.order.findUniqueOrThrow({
                  where: { id: pending.id },
                }),
              ).toMatchObject({
                status: 'PENDING_PAYMENT',
                totalInCents: 9500,
              });
              expect(
                (
                  await request(http)
                    .get(detailPath)
                    .set('Authorization', adminToken)
                ).body.suborders,
              ).toHaveLength(2);
              const full = await makeOrder(true);
              for (const suborder of full.storeOrders) {
                const confirmation = await request(http)
                  .post(
                    `/api/order-management/store-orders/${suborder.id}/confirm`,
                  )
                  .set('Authorization', adminToken)
                  .send({
                    expectedUpdatedAt: suborder.updatedAt.toISOString(),
                    reason: 'Confirmacion completa de todas las unidades',
                    items: suborder.items.map((record) => ({
                      orderItemId: record.id,
                      confirmedQuantity: record.quantity,
                    })),
                  })
                  .expect(201);
                expect(confirmation.body.status).toBe('CONFIRMED');
              }
              expect(
                await transaction.order.findUniqueOrThrow({
                  where: { id: full.id },
                }),
              ).toMatchObject({ status: 'CONFIRMED', totalInCents: 9500 });
              expect(
                await transaction.fulfillmentException.count({
                  where: { storeOrder: { orderId: full.id } },
                }),
              ).toBe(0);
              const rejected = await makeOrder(true);
              const rejectedInventory = await transaction.inventory.findMany({
                where: {
                  variantId: { in: variants.map((variant) => variant.id) },
                },
                orderBy: { variantId: 'asc' },
                select: { quantity: true },
              });
              for (const suborder of rejected.storeOrders) {
                const confirmation = await request(http)
                  .post(
                    `/api/order-management/store-orders/${suborder.id}/confirm`,
                  )
                  .set('Authorization', adminToken)
                  .send({
                    expectedUpdatedAt: suborder.updatedAt.toISOString(),
                    reason: 'No hay unidades fisicas disponibles',
                    items: suborder.items.map((record) => ({
                      orderItemId: record.id,
                      confirmedQuantity: 0,
                    })),
                  })
                  .expect(201);
                expect(confirmation.body.status).toBe('REJECTED');
              }
              expect(
                await transaction.order.findUniqueOrThrow({
                  where: { id: rejected.id },
                }),
              ).toMatchObject({ status: 'PAID', totalInCents: 9500 });
              expect(
                await transaction.payment.findUniqueOrThrow({
                  where: { orderId: rejected.id },
                }),
              ).toMatchObject({ status: 'CAPTURED', amountInCents: 9500 });
              expect(
                await transaction.stockMovement.count({
                  where: {
                    orderItem: { storeOrder: { orderId: rejected.id } },
                  },
                }),
              ).toBe(0);
              expect(
                await transaction.stockHold.count({
                  where: { orderId: rejected.id, status: 'FIRM' },
                }),
              ).toBe(0);
              expect(
                await transaction.fulfillmentException.count({
                  where: {
                    storeOrder: { orderId: rejected.id },
                    type: 'OUT_OF_STOCK',
                  },
                }),
              ).toBe(2);
              expect(
                await transaction.inventory.findMany({
                  where: {
                    variantId: { in: variants.map((variant) => variant.id) },
                  },
                  orderBy: { variantId: 'asc' },
                  select: { quantity: true },
                }),
              ).toEqual(rejectedInventory);
            } finally {
              await app.close();
            }
            throw rollback;
          },
          { timeout: 90000 },
        ),
      ).rejects.toThrow(rollback.message);
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
  100000,
);

it.skipIf(process.env.RUN_ORDER_MANAGEMENT_INTEGRATION !== '1')(
  'serializes simultaneous confirmations and retries across sibling stores in a disposable local database',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { spawnSync } = await import('node:child_process');
    const { parse } = await import('dotenv');
    const { Client } = await import('pg');
    const { ConfigService } = await import('@nestjs/config');
    const { PrismaService } = await import('../database/prisma.service.js');
    const { CustomersService } =
      await import('../customers/customers.service.js');
    const { StoreAccessService } =
      await import('../stores/store-access.service.js');
    const { OrderManagementService } =
      await import('./order-management.service.js');
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const databaseName = `orders_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
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
    const prisma = new PrismaService(
      new ConfigService({ ...environment, DB_NAME: databaseName }),
    );
    let created = false;
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
      const user = await prisma.user.create({
        data: {
          username: 'concurrent-order-admin',
          displayName: 'Local test only',
          passwordHash: 'unused',
        },
      });
      const actor = {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        sessionId: randomUUID(),
        roles: ['SUPER_ADMIN'],
        storeIds: [],
        mustChangePassword: false,
      };
      const customer = await prisma.customer.create({
        data: {
          fullName: 'Local order fixture',
          phone: '999888777',
          addresses: {
            create: {
              recipientName: 'Local test',
              recipientPhone: '999888777',
              zoneType: 'LIMA',
              city: 'Lima',
              line1: 'Local test only',
            },
          },
        },
        include: { addresses: true },
      });
      const variants = [];
      for (const index of [1, 2]) {
        const store = await prisma.store.create({
          data: {
            displayName: `Concurrency store ${index}`,
            whatsappNumber: `concurrent-${index}`,
            status: 'ACTIVE',
          },
        });
        const product = await prisma.product.create({
          data: {
            storeId: store.id,
            name: `Concurrent item ${index}`,
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
                inventory: { create: { quantity: 5 } },
              },
            },
          },
          include: { variants: true },
        });
        variants.push({ storeId: store.id, ...product.variants[0] });
      }
      const order = await prisma.order.create({
        data: {
          orderNumber: `T-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
          customerId: customer.id,
          shippingAddressId: customer.addresses[0].id,
          status: 'PAID',
          subtotalInCents: 4000,
          shippingInCents: 500,
          totalInCents: 4500,
          payment: {
            create: {
              provider: 'LOCAL_TEST_ONLY',
              idempotencyKey: randomUUID(),
              status: 'CAPTURED',
              amountInCents: 4500,
              capturedAt: new Date(),
            },
          },
          storeOrders: {
            create: variants.map((variant) => ({
              storeId: variant.storeId,
              subtotalInCents: 2000,
              items: {
                create: {
                  variantId: variant.id,
                  productName: 'Concurrent item',
                  sku: variant.sku,
                  sizeLabel: 'M',
                  color: 'Azul',
                  quantity: 2,
                  unitPriceInCents: 1000,
                  totalInCents: 2000,
                },
              },
            })),
          },
        },
        include: { storeOrders: { include: { items: true } } },
      });
      for (const suborder of order.storeOrders)
        for (const item of suborder.items)
          await prisma.stockHold.create({
            data: {
              orderId: order.id,
              orderItemId: item.id,
              variantId: item.variantId,
              quantity: 2,
              status: 'FIRM',
              firmedAt: new Date(),
            },
          });
      const service = new OrderManagementService(
        prisma,
        new CustomersService(
          prisma,
          {} as ConstructorParameters<typeof CustomersService>[1],
        ),
        new StoreAccessService(prisma),
      );
      const [first, second] = order.storeOrders;
      const input = (suborder: typeof first) => ({
        expectedUpdatedAt: suborder.updatedAt.toISOString(),
        reason: 'Disponibilidad completa, prueba local',
        items: suborder.items.map((item) => ({
          orderItemId: item.id,
          confirmedQuantity: item.quantity,
        })),
      });
      const results = await Promise.allSettled([
        service.confirm(first.id, input(first), actor),
        service.confirm(first.id, input(first), actor),
        service.confirm(second.id, input(second), actor),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(2);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      if (rejected[0].status === 'rejected')
        expect(rejected[0].reason.getStatus()).toBe(409);
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      ).toMatchObject({ status: 'CONFIRMED', totalInCents: 4500 });
      expect(
        await prisma.inventory.findMany({
          select: { quantity: true, needsReview: true },
        }),
      ).toEqual([
        { quantity: 3, needsReview: false },
        { quantity: 3, needsReview: false },
      ]);
      expect(
        await prisma.stockMovement.count({ where: { type: 'SALE' } }),
      ).toBe(2);
      expect(
        await prisma.stockHold.count({
          where: { status: 'CONSUMED', quantity: 2 },
        }),
      ).toBe(2);
      expect(await prisma.stockHold.count({ where: { status: 'FIRM' } })).toBe(
        0,
      );
      expect(
        await prisma.auditLog.count({
          where: { action: 'STORE_ORDER_CONFIRMED' },
        }),
      ).toBe(2);
      const report = {
        requestId: randomUUID(),
        expectedUpdatedAt: (
          await prisma.storeOrder.findUniqueOrThrow({ where: { id: first.id } })
        ).updatedAt.toISOString(),
        reason: 'Etiqueta diferente, prueba local',
        type: 'ITEM_MISMATCH' as const,
        items: [{ orderItemId: first.items[0].id, quantity: 1 }],
      };
      const reports = await Promise.all([
        service.report(first.id, report, actor),
        service.report(first.id, report, actor),
      ]);
      expect(reports[0]).toEqual(reports[1]);
      expect(await prisma.fulfillmentException.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
      if (created)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
  100000,
);
