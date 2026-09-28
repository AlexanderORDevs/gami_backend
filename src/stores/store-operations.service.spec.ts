import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdjustStoreInventoryDto,
  CreateStoreOrderDto,
  CreateStoreProductDto,
  CreateStoreShipmentDto,
} from './store-operations.dto.js';

const productInput = {
  name: 'Pantalon recto',
  description: 'Pantalon de algodon con bolsillos',
  category: 'inferior',
  garmentType: 'pantalon_recto',
  unitPriceInCents: 8500,
  gender: 'unisex',
  mainColor: 'azul',
  pattern: 'liso',
  fit: 'regular',
  length: 'largo',
  imageUrls: ['https://example.com/product.jpg'],
  variants: [{ sizeLabel: 'M', color: 'azul', quantity: 12 }],
};

describe('store operation validation', () => {
  it('accepts complete products and rejects unsafe or incomplete data', async () => {
    const check = (input: object) =>
      validate(plainToInstance(CreateStoreProductDto, input), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(await check(productInput)).toHaveLength(0);
    for (const patch of [
      { name: '   ' },
      { description: '' },
      { unitPriceInCents: -1 },
      { unitPriceInCents: 1.5 },
      { imageUrls: ['javascript:alert(1)'] },
      { variants: [] },
      { variants: [{ sizeLabel: '', color: 'Azul', quantity: -1 }] },
      { storeId: 'forged' },
      { status: 'PUBLISHED' },
    ])
      expect(
        (await check({ ...productInput, ...patch })).length,
      ).toBeGreaterThan(0);
  });

  it('requires complete orders and rejects duplicate items and invalid quantities', async () => {
    const input = {
      customerName: 'Cliente Prueba',
      customerPhone: '999888777',
      recipientName: 'Cliente Prueba',
      recipientPhone: '999888777',
      zoneType: 'LIMA',
      city: 'Lima',
      district: 'La Victoria',
      line1: 'Av. Prueba 123',
      shippingInCents: 1000,
      items: [
        { variantId: 'ab9d0102-794e-4d6b-9185-000000000001', quantity: 1 },
      ],
    };
    const check = (value: object) =>
      validate(plainToInstance(CreateStoreOrderDto, value), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(await check(input)).toHaveLength(0);
    for (const patch of [
      { customerPhone: 'abc' },
      { line1: '' },
      { items: [] },
      { items: [...input.items, ...input.items] },
      { totalInCents: 1 },
      { items: [{ ...input.items[0], quantity: 0 }] },
      { status: 'PAID' },
    ]) {
      expect((await check({ ...input, ...patch })).length).toBeGreaterThan(0);
    }
  });

  it('requires stock concurrency token and a reason', async () => {
    const check = (input: object) =>
      validate(plainToInstance(AdjustStoreInventoryDto, input));
    expect(
      await check({
        quantity: 5,
        expectedQuantity: null,
        reason: 'Conteo fisico',
      }),
    ).toHaveLength(0);
    expect((await check({ quantity: 5, reason: ' ' })).length).toBeGreaterThan(
      0,
    );
  });

  it('validates shipment identity, provider and dates', async () => {
    const input = {
      orderId: 'ab9d0102-794e-4d6b-9185-000000000001',
      method: 'Courier',
      provider: 'Operador',
    };
    expect(
      await validate(plainToInstance(CreateStoreShipmentDto, input)),
    ).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(CreateStoreShipmentDto, {
            ...input,
            pickupScheduledAt: 'not-a-date',
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});

it.skipIf(process.env.RUN_STORE_OPERATIONS_INTEGRATION !== '1')(
  'creates products, stock, orders and shipments through scoped HTTP and rolls back fixtures',
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
    const prefix = `ops-${randomUUID()}`;
    const rollback = new Error('Rollback operation fixtures');
    try {
      await expect(
        database.$transaction(
          async (transaction) => {
            const store = await transaction.store.create({
              data: {
                displayName: prefix,
                whatsappNumber: `${prefix.slice(0, 24)}1`,
                status: 'ACTIVE',
              },
            });
            const other = await transaction.store.create({
              data: {
                displayName: `${prefix}-other`,
                whatsappNumber: `${prefix.slice(0, 24)}2`,
                status: 'ACTIVE',
              },
            });
            const user = await transaction.user.create({
              data: {
                username: prefix,
                displayName: 'Operations fixture',
                passwordHash: 'unused',
                storeMemberships: {
                  create: { storeId: store.id, role: 'STORE_ADMIN' },
                },
              },
            });
            const session = await transaction.authSession.create({
              data: {
                userId: user.id,
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
                { sub: user.id, sid: session.id, type: 'access' },
                {
                  secret: app
                    .get(ConfigService)
                    .getOrThrow<string>('JWT_SECRET'),
                },
              );
              const authorization = `Bearer ${token}`;
              const http = app.getHttpServer();
              const base = `/api/store-workspace/stores/${store.id}`;
              const otherBase = `/api/store-workspace/stores/${other.id}`;
              await request(http)
                .post(`${otherBase}/products`)
                .set('Authorization', authorization)
                .send(productInput)
                .expect(403);
              await request(http)
                .post(`${base}/products`)
                .set('Authorization', authorization)
                .send({ ...productInput, storeId: other.id })
                .expect(400);
              await request(http)
                .post(`${base}/products`)
                .set('Authorization', authorization)
                .send({
                  ...productInput,
                  variants: [
                    productInput.variants[0],
                    productInput.variants[0],
                  ],
                })
                .expect(400);
              await request(http)
                .post(`${base}/products`)
                .set('Authorization', authorization)
                .send({ ...productInput, wholesalePriceInCents: 900 })
                .expect(400);
              await request(http)
                .post(`${base}/products`)
                .set('Authorization', authorization)
                .send({ ...productInput, length: undefined })
                .expect(400);
              const created = await request(http)
                .post(`${base}/products`)
                .set('Authorization', authorization)
                .send(productInput)
                .expect(201);
              expect(created.body.status).toBe('UNDER_REVIEW');
              const product = await transaction.product.findUniqueOrThrow({
                where: { id: created.body.id },
                include: {
                  variants: {
                    include: { inventory: true, stockMovements: true },
                  },
                  productAttributes: true,
                },
              });
              expect(product.storeId).toBe(store.id);
              expect(product.variants[0].inventory?.quantity).toBe(12);
              expect(product.variants[0].stockMovements[0].type).toBe(
                'INITIAL',
              );
              expect(product.productAttributes[0].value).toBe(
                productInput.imageUrls[0],
              );
              const variantId = product.variants[0].id;
              const orderInput = {
                customerName: prefix,
                customerPhone: '999888777',
                recipientName: 'Cliente Prueba',
                recipientPhone: '999888777',
                zoneType: 'LIMA',
                city: 'Lima',
                district: 'La Victoria',
                line1: 'Av. Prueba 123',
                shippingInCents: 1000,
                items: [{ variantId, quantity: 2 }],
              };
              await request(http)
                .post(`${base}/orders`)
                .set('Authorization', authorization)
                .send(orderInput)
                .expect(400);
              await transaction.product.update({
                where: { id: product.id },
                data: { status: 'PUBLISHED' },
              });
              await request(http)
                .post(`${otherBase}/orders`)
                .set('Authorization', authorization)
                .send(orderInput)
                .expect(403);
              await request(http)
                .post(`${base}/orders`)
                .set('Authorization', authorization)
                .send({ ...orderInput, totalInCents: 1 })
                .expect(400);
              await request(http)
                .patch(`${base}/inventory/${variantId}`)
                .set('Authorization', authorization)
                .send({
                  quantity: 8,
                  expectedQuantity: 0,
                  reason: 'Conteo prueba',
                })
                .expect(409);
              await request(http)
                .patch(`${base}/inventory/${variantId}`)
                .set('Authorization', authorization)
                .send({
                  quantity: 8,
                  expectedQuantity: 12,
                  reason: 'Conteo prueba',
                })
                .expect(200);
              const order = await request(http)
                .post(`${base}/orders`)
                .set('Authorization', authorization)
                .send(orderInput)
                .expect(201);
              expect(order.body.totalInCents).toBe(18000);
              expect(order.body.status).toBe('PENDING_PAYMENT');
              const held = await transaction.stockHold.findFirstOrThrow({
                where: { orderId: order.body.id },
              });
              expect(held.quantity).toBe(2);
              expect(held.status).toBe('LIVE');
              expect(held.expiresAt!.getTime()).toBeGreaterThan(Date.now());
              await request(http)
                .patch(`${base}/inventory/${variantId}`)
                .set('Authorization', authorization)
                .send({
                  quantity: 1,
                  expectedQuantity: 8,
                  reason: 'Menor que reserva',
                })
                .expect(409);
              await request(http)
                .post(`${base}/orders`)
                .set('Authorization', authorization)
                .send({ ...orderInput, items: [{ variantId, quantity: 7 }] })
                .expect(409);
              const variantList = await request(http)
                .get(`${base}/order-variants`)
                .set('Authorization', authorization)
                .expect(200);
              expect(variantList.body.data[0].available).toBe(6);
              const shipmentInput = {
                orderId: order.body.id,
                method: 'Courier',
                provider: 'Proveedor prueba',
              };
              await request(http)
                .post(`${otherBase}/shipments`)
                .set('Authorization', authorization)
                .send(shipmentInput)
                .expect(403);
              await request(http)
                .post(`${base}/shipments`)
                .set('Authorization', authorization)
                .send({ ...shipmentInput, status: 'DELIVERED' })
                .expect(400);
              await request(http)
                .post(`${base}/shipments`)
                .set('Authorization', authorization)
                .send({
                  ...shipmentInput,
                  pickupScheduledAt: '2020-01-01T10:00:00Z',
                })
                .expect(400);
              const shipment = await request(http)
                .post(`${base}/shipments`)
                .set('Authorization', authorization)
                .send(shipmentInput)
                .expect(201);
              expect(shipment.body.status).toBe('PENDING');
              expect(
                (
                  await transaction.shipment.findUniqueOrThrow({
                    where: { id: shipment.body.id },
                  })
                ).shippingRateInCents,
              ).toBe(1000);
              await request(http)
                .post(`${base}/shipments`)
                .set('Authorization', authorization)
                .send(shipmentInput)
                .expect(409);
              const options = await request(http)
                .get(`${base}/shipment-orders`)
                .set('Authorization', authorization)
                .expect(200);
              expect(options.body.data).toHaveLength(0);
              await transaction.storeMember.update({
                where: {
                  userId_storeId: { userId: user.id, storeId: store.id },
                },
                data: { role: 'STORE_ATTENTION' },
              });
              await request(http)
                .get(`${base}/information/products`)
                .set('Authorization', authorization)
                .expect(200);
              await request(http)
                .post(`${base}/products`)
                .set('Authorization', authorization)
                .send(productInput)
                .expect(403);
              await request(http)
                .patch(`${base}/inventory/${variantId}`)
                .set('Authorization', authorization)
                .send({
                  quantity: 10,
                  expectedQuantity: 8,
                  reason: 'Sin permiso',
                })
                .expect(403);
              await transaction.storeMember.update({
                where: {
                  userId_storeId: { userId: user.id, storeId: store.id },
                },
                data: { active: false },
              });
              await request(http)
                .post(`${base}/orders`)
                .set('Authorization', authorization)
                .send(orderInput)
                .expect(403);
              const operations = app.get(
                (await import('./store-operations.service.js'))
                  .StoreOperationsService,
              );
              const globalActor = {
                userId: user.id,
                username: prefix,
                displayName: 'Operations fixture',
                roles: ['SUPER_ADMIN'],
                storeIds: [],
                mustChangePassword: false,
                sessionId: session.id,
              };
              const globalProduct = await operations.createProduct(
                other.id,
                productInput,
                globalActor,
                {},
              );
              const foreign = await transaction.product.findUniqueOrThrow({
                where: { id: globalProduct.id },
                include: { variants: true },
              });
              expect(foreign.storeId).toBe(other.id);
              await expect(
                operations.adjustInventory(
                  store.id,
                  foreign.variants[0].id,
                  { quantity: 1, expectedQuantity: 12, reason: 'Cross store' },
                  globalActor,
                  {},
                ),
              ).rejects.toThrow('La variante no pertenece');
              await expect(
                operations.createOrder(
                  store.id,
                  {
                    ...orderInput,
                    zoneType: 'LIMA',
                    items: [{ variantId: foreign.variants[0].id, quantity: 1 }],
                  },
                  globalActor,
                  {},
                ),
              ).rejects.toThrow('Una variante');
              await expect(
                operations.createShipment(
                  other.id,
                  shipmentInput,
                  globalActor,
                  {},
                ),
              ).rejects.toThrow('La orden no pertenece');
              expect(
                await transaction.auditLog.count({
                  where: {
                    actorUserId: user.id,
                    action: {
                      in: [
                        'PRODUCT_CREATED',
                        'INVENTORY_ADJUSTED',
                        'ORDER_CREATED',
                        'SHIPMENT_CREATED',
                      ],
                    },
                  },
                }),
              ).toBe(5);
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
      expect(
        await database.customer.count({ where: { fullName: prefix } }),
      ).toBe(0);
    } finally {
      await database.$disconnect();
    }
  },
  100000,
);
