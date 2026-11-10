import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterCustomerDto } from './customers.dto.js';

it('allows only public customer registration fields', async () => {
  const input = {
    username: 'Client.Test',
    displayName: 'Cliente de prueba',
    email: 'CLIENT@example.com',
    phone: '999888777',
    password: 'Local-fixture-password-123',
  };
  const dto = plainToInstance(RegisterCustomerDto, input);
  expect(dto.username).toBe('client.test');
  expect(dto.email).toBe('client@example.com');
  expect(
    await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
  ).toHaveLength(0);
  for (const extra of [
    { roles: ['SUPER_ADMIN'] },
    { storeId: 'forged' },
    { mustChangePassword: false },
    { status: 'ACTIVE' },
    { password: 'short' },
    { phone: '99988877' },
    { phone: '9998887770' },
    { phone: '+51999888777' },
    { phone: '899888777' },
    { phone: '99988a777' },
  ]) {
    expect(
      (
        await validate(
          plainToInstance(RegisterCustomerDto, { ...input, ...extra }),
          { whitelist: true, forbidNonWhitelisted: true },
        )
      ).length,
    ).toBeGreaterThan(0);
  }
});

it.skipIf(process.env.RUN_CUSTOMERS_INTEGRATION !== '1')(
  'registers real customer sessions, isolates accounts and blocks internal privilege escalation, then rolls back',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { parse } = await import('dotenv');
    const { ConfigService } = await import('@nestjs/config');
    const { Test } = await import('@nestjs/testing');
    const { ValidationPipe } = await import('@nestjs/common');
    const { JwtService } = await import('@nestjs/jwt');
    const { ThrottlerGuard } = await import('@nestjs/throttler');
    const { default: request } = await import('supertest');
    const { PrismaService } = await import('../database/prisma.service.js');
    const { AppModule } = await import('../app.module.js');
    const environment = parse(
      readFileSync(new URL('../../.env', import.meta.url)),
    );
    expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
    const database = new PrismaService(new ConfigService(environment));
    const prefix = `client-${randomUUID()}`;
    const rollback = new Error('Rollback customer fixtures');
    try {
      await expect(
        database.$transaction(
          async (transaction) => {
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
              const registration = {
                username: `${prefix}-a`,
                displayName: 'Cliente prueba',
                email: `${prefix}-a@example.com`,
                phone: `91${randomUUID().replaceAll(/\D/g, '').padEnd(7, '0').slice(0, 7)}`,
                password: 'Local-fixture-password-123',
              };
              await request(http)
                .post('/api/customers/register')
                .send({ ...registration, roles: ['SUPER_ADMIN'] })
                .expect(400);
              await request(http)
                .post('/api/customers/register')
                .send({ ...registration, storeId: randomUUID() })
                .expect(400);
              const first = await request(http)
                .post('/api/customers/register')
                .send(registration)
                .expect(201);
              expect(first.body.user.roles).toEqual(['CUSTOMER']);
              expect(first.body.user.storeIds).toEqual([]);
              expect(first.body.user.mustChangePassword).toBe(false);
              const second = await request(http)
                .post('/api/customers/register')
                .send({
                  ...registration,
                  username: `${prefix}-b`,
                  email: `${prefix}-b@example.com`,
                  phone: `92${randomUUID().replaceAll(/\D/g, '').padEnd(7, '0').slice(0, 7)}`,
                })
                .expect(201);
              const tokenA = `Bearer ${first.body.tokens.accessToken}`;
              const tokenB = `Bearer ${second.body.tokens.accessToken}`;
              await request(http)
                .post('/api/customers/register')
                .send({
                  ...registration,
                  username: registration.username.toUpperCase(),
                })
                .expect(409);
              await request(http)
                .post('/api/customers/login')
                .send({
                  username: registration.username.toUpperCase(),
                  password: registration.password,
                })
                .expect(201);
              await request(http).get('/api/customers/me').expect(401);
              await request(http)
                .get('/api/admin/users')
                .set('Authorization', tokenA)
                .expect(403);
              await request(http)
                .post('/api/admin/users')
                .set('Authorization', tokenA)
                .send({})
                .expect(403);
              await request(http)
                .get('/api/store-workspace/stores')
                .set('Authorization', tokenA)
                .expect(200)
                .expect([]);
              const store = await transaction.store.create({
                data: {
                  displayName: prefix,
                  whatsappNumber: `${prefix.slice(0, 23)}-1`,
                  status: 'ACTIVE',
                },
              });
              const product = await transaction.product.create({
                data: {
                  storeId: store.id,
                  name: prefix,
                  category: 'Test',
                  garmentType: 'Test',
                  unitPriceInCents: 1000,
                  status: 'PUBLISHED',
                  variants: {
                    create: {
                      sku: prefix,
                      sizeLabel: 'M',
                      sizeNormalized: 'M',
                      color: 'Azul',
                      inventory: { create: { quantity: 5 } },
                    },
                  },
                },
                include: { variants: true },
              });
              const variant = product.variants[0];
              await request(http)
                .put(`/api/customers/me/cart/${variant.id}`)
                .set('Authorization', tokenA)
                .send({ quantity: 2, customerId: second.body.user.id })
                .expect(400);
              await request(http)
                .put(`/api/customers/me/cart/${variant.id}`)
                .set('Authorization', tokenA)
                .send({ quantity: 2 })
                .expect(200);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/cart')
                    .set('Authorization', tokenA)
                    .expect(200)
                ).body,
              ).toHaveLength(1);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/cart')
                    .set('Authorization', tokenB)
                    .expect(200)
                ).body,
              ).toHaveLength(0);
              await request(http)
                .delete(`/api/customers/me/cart/${variant.id}`)
                .set('Authorization', tokenB)
                .expect(200);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/cart')
                    .set('Authorization', tokenA)
                    .expect(200)
                ).body[0].quantity,
              ).toBe(2);
              await request(http)
                .put(`/api/customers/me/favorites/${product.id}`)
                .set('Authorization', tokenA)
                .expect(200);
              await request(http)
                .put(`/api/customers/me/favorites/${product.id}`)
                .set('Authorization', tokenA)
                .expect(200);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/favorites')
                    .set('Authorization', tokenA)
                ).body,
              ).toEqual([product.id]);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/favorites')
                    .set('Authorization', tokenB)
                ).body,
              ).toEqual([]);
              await request(http)
                .patch('/api/customers/me')
                .set('Authorization', tokenA)
                .send({
                  displayName: 'Nombre actualizado',
                  phone: registration.phone,
                  roles: ['SUPER_ADMIN'],
                })
                .expect(400);
              await request(http)
                .patch('/api/customers/me')
                .set('Authorization', tokenA)
                .send({
                  displayName: 'Nombre actualizado',
                  phone: registration.phone,
                })
                .expect(200);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me')
                    .set('Authorization', tokenA)
                ).body.fullName,
              ).toBe('Nombre actualizado');
              await transaction.shippingRate.updateMany({
                where: { zoneType: 'LIMA' },
                data: { active: false },
              });
              await transaction.shippingRate.create({
                data: {
                  zoneType: 'LIMA',
                  district: prefix,
                  rateInCents: 100,
                  effectiveFrom: new Date(Date.now() - 60000),
                },
              });
              const input = {
                customerName: 'Nombre actualizado',
                customerPhone: registration.phone,
                recipientName: 'Nombre actualizado',
                recipientPhone: registration.phone,
                zoneType: 'LIMA',
                city: 'Lima',
                district: prefix,
                line1: 'Av. Prueba 123',
                requestId: randomUUID(),
                expectedSubtotalInCents: 2000,
                expectedShippingInCents: 100,
                items: [{ variantId: variant.id, quantity: 2 }],
              };
              await request(http)
                .post('/api/checkout/orders')
                .send(input)
                .expect(401);
              const created = await request(http)
                .post('/api/checkout/orders')
                .set('Authorization', tokenA)
                .send(input)
                .expect(201);
              await request(http)
                .post('/api/checkout/orders')
                .set('Authorization', tokenA)
                .send(input)
                .expect(201)
                .expect(created.body);
              await request(http)
                .post('/api/checkout/orders')
                .set('Authorization', tokenB)
                .send(input)
                .expect(409);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/orders')
                    .set('Authorization', tokenA)
                ).body.total,
              ).toBe(1);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/orders')
                    .set('Authorization', tokenB)
                ).body.total,
              ).toBe(0);
              expect(
                (
                  await request(http)
                    .get('/api/customers/me/cart')
                    .set('Authorization', tokenA)
                ).body,
              ).toEqual([]);
              const order = await transaction.order.findUniqueOrThrow({
                where: { orderNumber: created.body.orderNumber },
                include: { customer: true },
              });
              expect(order.customer.userId).toBe(first.body.user.id);
              const adminRole = await transaction.role.findUniqueOrThrow({
                where: { code: 'SUPER_ADMIN' },
              });
              const admin = await transaction.user.create({
                data: {
                  username: `${prefix}-admin`,
                  displayName: 'Staff fixture',
                  passwordHash: await (
                    await import('bcryptjs')
                  ).hash('Local-staff-fixture-password-123', 4),
                  roles: { create: { roleId: adminRole.id } },
                },
              });
              const adminSession = await transaction.authSession.create({
                data: {
                  userId: admin.id,
                  familyId: randomUUID(),
                  tokenHash: randomUUID(),
                  expiresAt: new Date(Date.now() + 60000),
                },
              });
              const adminToken = await app
                .get(JwtService)
                .signAsync(
                  { sub: admin.id, sid: adminSession.id, type: 'access' },
                  { secret: environment.JWT_SECRET },
                );
              await request(http)
                .get('/api/customers/me')
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(403);
              await request(http)
                .post('/api/checkout/orders')
                .set('Authorization', `Bearer ${adminToken}`)
                .send(input)
                .expect(403);
              await request(http)
                .post('/api/customers/login')
                .send({
                  username: admin.username,
                  password: 'Local-staff-fixture-password-123',
                })
                .expect(403);
              expect(
                await transaction.authSession.count({
                  where: {
                    userId: admin.id,
                    revokeReason: 'NOT_CUSTOMER_LOGIN',
                    revokedAt: { not: null },
                  },
                }),
              ).toBe(1);
              await transaction.userRole.create({
                data: { userId: second.body.user.id, roleId: adminRole.id },
              });
              await request(http)
                .get('/api/customers/me')
                .set('Authorization', tokenB)
                .expect(403);
              await request(http)
                .post('/api/auth/logout')
                .set('Authorization', tokenA)
                .expect(204);
              await request(http)
                .get('/api/customers/me/cart')
                .set('Authorization', tokenA)
                .expect(401);
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
    } finally {
      await database.$disconnect();
    }
  },
  100000,
);
