import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { LoginDto } from '../auth/dto/auth.dto.js';
import type { AuthenticatedUser, RequestContext } from '../auth/auth.types.js';
import type {
  CustomerProfileDto,
  RegisterCustomerDto,
} from './customers.dto.js';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async requireCustomer(
    actor: AuthenticatedUser,
    transaction: Prisma.TransactionClient = this.prisma,
  ) {
    if (
      actor.mustChangePassword ||
      actor.roles.length !== 1 ||
      actor.roles[0] !== 'CUSTOMER'
    )
      throw new ForbiddenException(
        'Esta operación requiere una cuenta de cliente.',
      );
    const customer = await transaction.customer.findFirst({
      where: {
        userId: actor.userId,
        deletedAt: null,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
          roles: {
            some: { role: { code: 'CUSTOMER' } },
            every: { role: { code: 'CUSTOMER' } },
          },
          storeMemberships: { none: { active: true } },
        },
      },
      select: { id: true },
    });
    if (!customer)
      throw new ForbiddenException(
        'No se encontró un perfil de cliente activo.',
      );
    return customer.id;
  }

  private rethrowConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      throw new ConflictException(
        'No se pudo usar ese usuario, correo o teléfono.',
      );
    throw error;
  }

  async register(input: RegisterCustomerDto, context: RequestContext) {
    if (Buffer.byteLength(input.password, 'utf8') > 72)
      throw new BadRequestException(
        'La contraseña supera el tamaño permitido.',
      );
    const passwordHash = await hash(input.password, 12);
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('gami:public-registration'))`;
        const existing = await transaction.user.count({
          where: {
            OR: [
              { username: { equals: input.username, mode: 'insensitive' } },
              { email: { equals: input.email, mode: 'insensitive' } },
              { phone: input.phone },
            ],
          },
        });
        if (existing)
          throw new ConflictException(
            'No se pudo usar ese usuario, correo o teléfono.',
          );
        const role = await transaction.role.findUnique({
          where: { code: 'CUSTOMER' },
          select: { id: true },
        });
        if (!role)
          throw new BadRequestException(
            'El registro de clientes no está disponible. Contacta con Gami.',
          );
        const user = await transaction.user.create({
          data: {
            username: input.username,
            displayName: input.displayName,
            email: input.email,
            phone: input.phone,
            passwordHash,
            mustChangePassword: false,
            passwordChangedAt: new Date(),
            status: 'ACTIVE',
            roles: { create: { roleId: role.id } },
            customer: {
              create: {
                fullName: input.displayName,
                email: input.email,
                phone: input.phone,
              },
            },
          },
          select: { id: true },
        });
        await transaction.auditLog.create({
          data: {
            actorUserId: user.id,
            entityType: 'user',
            entityId: user.id,
            action: 'CUSTOMER_REGISTERED',
            channel: 'CUSTOMER_APP',
          },
        });
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
    return this.auth.login(
      { username: input.username, password: input.password },
      context,
    );
  }

  async login(input: LoginDto, context: RequestContext) {
    const result = await this.auth.login(input, context);
    const customer = await this.prisma.customer.findFirst({
      where: { userId: result.user.id, deletedAt: null },
      select: { id: true },
    });
    if (
      result.user.roles.length !== 1 ||
      result.user.roles[0] !== 'CUSTOMER' ||
      !customer
    ) {
      await this.prisma.authSession.updateMany({
        where: {
          tokenHash: createHash('sha256')
            .update(result.tokens.refreshToken)
            .digest('hex'),
        },
        data: { revokedAt: new Date(), revokeReason: 'NOT_CUSTOMER_LOGIN' },
      });
      throw new ForbiddenException(
        'Esta cuenta corresponde al portal de tiendas y administración.',
      );
    }
    return result;
  }

  async profile(actor: AuthenticatedUser) {
    const id = await this.requireCustomer(actor);
    return this.prisma.customer.findUniqueOrThrow({
      where: { id },
      select: {
        fullName: true,
        email: true,
        phone: true,
        user: { select: { username: true } },
      },
    });
  }

  async updateProfile(actor: AuthenticatedUser, input: CustomerProfileDto) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const id = await this.requireCustomer(actor, transaction);
        await transaction.user.update({
          where: { id: actor.userId },
          data: { displayName: input.displayName, phone: input.phone },
        });
        await transaction.customer.update({
          where: { id },
          data: { fullName: input.displayName, phone: input.phone },
        });
        await transaction.auditLog.create({
          data: {
            actorUserId: actor.userId,
            entityType: 'customer',
            entityId: id,
            action: 'CUSTOMER_PROFILE_UPDATED',
            channel: 'CUSTOMER_APP',
          },
        });
        return { fullName: input.displayName, phone: input.phone };
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async cart(actor: AuthenticatedUser) {
    const customerId = await this.requireCustomer(actor);
    const now = new Date();
    const rows = await this.prisma.customerCartItem.findMany({
      where: { customerId },
      orderBy: { updatedAt: 'asc' },
      select: {
        quantity: true,
        variant: {
          select: {
            id: true,
            active: true,
            sizeLabel: true,
            color: true,
            inventory: { select: { quantity: true, needsReview: true } },
            stockHolds: {
              where: {
                OR: [
                  { status: 'FIRM' },
                  {
                    status: 'LIVE',
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                  },
                ],
              },
              select: { quantity: true },
            },
            product: {
              select: {
                id: true,
                name: true,
                status: true,
                deletedAt: true,
                unitPriceInCents: true,
                store: {
                  select: { displayName: true, status: true, deletedAt: true },
                },
                productAttributes: {
                  where: { code: 'image_url' },
                  orderBy: { position: 'asc' },
                  select: { value: true },
                },
              },
            },
          },
        },
      },
    });
    return rows.map(({ quantity, variant }) => {
      const { product } = variant;
      const visible =
        variant.active &&
        product.status === 'PUBLISHED' &&
        !product.deletedAt &&
        product.store.status === 'ACTIVE' &&
        !product.store.deletedAt;
      return {
        variantId: variant.id,
        productId: product.id,
        name: product.name,
        storeName: product.store.displayName,
        size: variant.sizeLabel,
        color: variant.color,
        quantity,
        unitPriceInCents: product.unitPriceInCents,
        imageUrl:
          product.productAttributes.find((item) =>
            item.value.startsWith('https://'),
          )?.value ?? null,
        availableStock:
          visible && variant.inventory && !variant.inventory.needsReview
            ? Math.max(
                0,
                variant.inventory.quantity -
                  variant.stockHolds.reduce(
                    (total, hold) => total + hold.quantity,
                    0,
                  ),
              )
            : 0,
      };
    });
  }

  async setCartItem(
    actor: AuthenticatedUser,
    variantId: string,
    quantity: number,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const customerId = await this.requireCustomer(actor, transaction);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:customer-cart:' + customerId}))`;
      const variant = await transaction.variant.findFirst({
        where: {
          id: variantId,
          active: true,
          product: {
            status: 'PUBLISHED',
            deletedAt: null,
            store: { status: 'ACTIVE', deletedAt: null },
          },
        },
        select: {
          id: true,
          inventory: { select: { quantity: true, needsReview: true } },
        },
      });
      if (!variant?.inventory || variant.inventory.needsReview)
        throw new NotFoundException(
          'La variante no tiene stock confirmado o ya no está disponible.',
        );
      const reserved = await transaction.stockHold.aggregate({
        where: {
          variantId,
          OR: [
            { status: 'FIRM' },
            {
              status: 'LIVE',
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          ],
        },
        _sum: { quantity: true },
      });
      if (quantity > variant.inventory.quantity - (reserved._sum.quantity ?? 0))
        throw new ConflictException('La cantidad supera el stock disponible.');
      const existing = await transaction.customerCartItem.findUnique({
        where: { customerId_variantId: { customerId, variantId } },
        select: { variantId: true },
      });
      if (
        !existing &&
        (await transaction.customerCartItem.count({ where: { customerId } })) >=
          50
      )
        throw new BadRequestException('El carrito admite hasta 50 variantes.');
      await transaction.customerCartItem.upsert({
        where: { customerId_variantId: { customerId, variantId } },
        create: { customerId, variantId, quantity },
        update: { quantity },
      });
      return { variantId, quantity };
    });
  }

  async removeCartItem(actor: AuthenticatedUser, variantId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const customerId = await this.requireCustomer(actor, transaction);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:customer-cart:' + customerId}))`;
      await transaction.customerCartItem.deleteMany({
        where: { customerId, variantId },
      });
      return { removed: true };
    });
  }

  async favorites(actor: AuthenticatedUser) {
    const customerId = await this.requireCustomer(actor);
    const rows = await this.prisma.customerFavorite.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: { productId: true },
    });
    return rows.map((item) => item.productId);
  }

  async favorite(actor: AuthenticatedUser, productId: string, active: boolean) {
    return this.prisma.$transaction(async (transaction) => {
      const customerId = await this.requireCustomer(actor, transaction);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gami:customer-favorites:' + customerId}))`;
      if (!active) {
        await transaction.customerFavorite.deleteMany({
          where: { customerId, productId },
        });
        return { saved: false };
      }
      const product = await transaction.product.findFirst({
        where: {
          id: productId,
          status: 'PUBLISHED',
          deletedAt: null,
          store: { status: 'ACTIVE', deletedAt: null },
        },
        select: { id: true },
      });
      if (!product)
        throw new NotFoundException('Esta prenda ya no está disponible.');
      const existing = await transaction.customerFavorite.findUnique({
        where: { customerId_productId: { customerId, productId } },
        select: { productId: true },
      });
      if (
        !existing &&
        (await transaction.customerFavorite.count({ where: { customerId } })) >=
          100
      )
        throw new BadRequestException('Puedes guardar hasta 100 prendas.');
      await transaction.customerFavorite.upsert({
        where: { customerId_productId: { customerId, productId } },
        create: { customerId, productId },
        update: {},
      });
      return { saved: true };
    });
  }

  async orders(actor: AuthenticatedUser, page: number) {
    const customerId = await this.requireCustomer(actor);
    const where = { customerId };
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * 20,
        take: 20,
        select: {
          orderNumber: true,
          status: true,
          totalInCents: true,
          createdAt: true,
          storeOrders: {
            select: {
              store: { select: { displayName: true } },
              items: {
                select: {
                  productName: true,
                  sizeLabel: true,
                  color: true,
                  quantity: true,
                  unitPriceInCents: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, total, page, pages: Math.ceil(total / 20) };
  }
}
