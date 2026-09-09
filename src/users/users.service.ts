import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Prisma, UserStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedUser, RequestContext } from '../auth/auth.types.js';
import type {
  CreateUserDto,
  UserAuditListResponseDto,
  UserAuditQueryDto,
  UserListQueryDto,
  UserListResponseDto,
  UserResponseDto,
} from './dto/users.dto.js';

const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  phone: true,
  status: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  roles: {
    select: { role: { select: { code: true } } },
    orderBy: { role: { code: 'asc' } },
  },
  storeMemberships: {
    select: {
      storeId: true,
      isOwner: true,
      active: true,
      store: { select: { displayName: true } },
    },
    orderBy: { store: { displayName: 'asc' } },
  },
} satisfies Prisma.UserSelect;

type SelectedUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  listRoles() {
    return this.prisma.role.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        system: true,
      },
      orderBy: { code: 'asc' },
    });
  }

  async create(
    input: CreateUserDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<{ user: UserResponseDto; temporaryPassword: string }> {
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = await hash(temporaryPassword, 12);

    try {
      const user = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.user.create({
          data: {
            username: input.username,
            displayName: input.displayName.trim(),
            email: input.email?.trim().toLowerCase(),
            phone: input.phone?.trim(),
            passwordHash,
            mustChangePassword: true,
            status: UserStatus.ACTIVE,
          },
          select: USER_SELECT,
        });

        await this.audit(
          transaction,
          actor.userId,
          created.id,
          'USER_CREATED',
          {
            context,
            toState: UserStatus.ACTIVE,
          },
        );

        return created;
      });

      return { user: this.toResponse(user), temporaryPassword };
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException(
          'Username, email, or phone already exists.',
        );
      }
      throw error;
    }
  }

  async list(query: UserListQueryDto): Promise<UserListResponseDto> {
    const search = query.search?.trim();
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status: query.status,
      ...(search
        ? {
            OR: [
              { username: { contains: search, mode: 'insensitive' } },
              { displayName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.limit;
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map((user) => this.toResponse(user)),
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(total / query.limit),
    };
  }

  async getById(userId: string): Promise<UserResponseDto> {
    const user = await this.findUser(userId);
    return this.toResponse(user);
  }

  async getAuditLog(
    userId: string,
    query: UserAuditQueryDto,
  ): Promise<UserAuditListResponseDto> {
    await this.findUser(userId);
    const where: Prisma.AuditLogWhereInput = {
      entityType: 'user',
      entityId: userId,
      action: query.action,
    };
    const [entries, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: entries.map((entry) => ({
        id: entry.id.toString(),
        actorUserId: entry.actorUserId,
        action: entry.action,
        fromState: entry.fromState,
        toState: entry.toState,
        reason: entry.reason,
        channel: entry.channel,
        metadata: entry.metadata,
        occurredAt: entry.occurredAt,
      })),
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(total / query.limit),
    };
  }

  async updateStatus(
    userId: string,
    status: UserStatus,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<UserResponseDto> {
    if (userId === actor.userId && status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('You cannot block your own account.');
    }

    const user = await this.prisma.$transaction(async (transaction) => {
      const current = await this.findUserInTransaction(transaction, userId);

      if (current.status === status) {
        return current;
      }

      if (status !== UserStatus.ACTIVE) {
        await this.protectLastSuperAdmin(transaction, userId);
      }

      const updated = await transaction.user.update({
        where: { id: userId },
        data: { status },
        select: USER_SELECT,
      });
      await transaction.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokeReason: `USER_${status}`,
        },
      });
      await this.audit(
        transaction,
        actor.userId,
        userId,
        'USER_STATUS_CHANGED',
        {
          context,
          fromState: current.status,
          toState: status,
          reason,
        },
      );

      return updated;
    });

    return this.toResponse(user);
  }

  async grantRole(
    userId: string,
    roleCode: string,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<UserResponseDto> {
    const user = await this.prisma.$transaction(async (transaction) => {
      await this.findUserInTransaction(transaction, userId);
      const role = await transaction.role.findUnique({
        where: { code: roleCode },
      });

      if (!role) {
        throw new NotFoundException(`Role ${roleCode} was not found.`);
      }

      await transaction.userRole.upsert({
        where: { userId_roleId: { userId, roleId: role.id } },
        update: {},
        create: { userId, roleId: role.id, grantedById: actor.userId },
      });
      await this.audit(transaction, actor.userId, userId, 'USER_ROLE_GRANTED', {
        context,
        reason,
        metadata: { roleCode },
      });

      return transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: USER_SELECT,
      });
    });

    return this.toResponse(user);
  }

  async revokeRole(
    userId: string,
    roleCode: string,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<UserResponseDto> {
    if (userId === actor.userId && roleCode === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'You cannot revoke your own SUPER_ADMIN role.',
      );
    }

    const user = await this.prisma.$transaction(async (transaction) => {
      await this.findUserInTransaction(transaction, userId);
      const role = await transaction.role.findUnique({
        where: { code: roleCode },
      });

      if (!role) {
        throw new NotFoundException(`Role ${roleCode} was not found.`);
      }

      const assignment = await transaction.userRole.findUnique({
        where: { userId_roleId: { userId, roleId: role.id } },
      });

      if (!assignment) {
        throw new NotFoundException('The user does not have this role.');
      }

      if (roleCode === 'SUPER_ADMIN') {
        await this.protectLastSuperAdmin(transaction, userId);
      }

      await transaction.userRole.delete({
        where: { userId_roleId: { userId, roleId: role.id } },
      });
      await transaction.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'ROLE_REVOKED' },
      });
      await this.audit(transaction, actor.userId, userId, 'USER_ROLE_REVOKED', {
        context,
        reason,
        metadata: { roleCode },
      });

      return transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: USER_SELECT,
      });
    });

    return this.toResponse(user);
  }

  async grantStore(
    userId: string,
    storeId: string,
    isOwner: boolean,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<UserResponseDto> {
    const user = await this.prisma.$transaction(async (transaction) => {
      await this.findUserInTransaction(transaction, userId);
      const store = await transaction.store.findFirst({
        where: { id: storeId, deletedAt: null },
      });

      if (!store) {
        throw new NotFoundException('Store was not found.');
      }

      await transaction.storeMember.upsert({
        where: { userId_storeId: { userId, storeId } },
        update: { active: true, isOwner },
        create: { userId, storeId, active: true, isOwner },
      });
      await this.audit(
        transaction,
        actor.userId,
        userId,
        'USER_STORE_ACCESS_GRANTED',
        {
          context,
          reason,
          metadata: { storeId, isOwner },
        },
      );

      return transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: USER_SELECT,
      });
    });

    return this.toResponse(user);
  }

  async revokeStore(
    userId: string,
    storeId: string,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<UserResponseDto> {
    const user = await this.prisma.$transaction(async (transaction) => {
      await this.findUserInTransaction(transaction, userId);
      const membership = await transaction.storeMember.findUnique({
        where: { userId_storeId: { userId, storeId } },
      });

      if (!membership?.active) {
        throw new NotFoundException('Active store membership was not found.');
      }

      await transaction.storeMember.update({
        where: { userId_storeId: { userId, storeId } },
        data: { active: false, isOwner: false },
      });
      await transaction.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'STORE_ACCESS_REVOKED' },
      });
      await this.audit(
        transaction,
        actor.userId,
        userId,
        'USER_STORE_ACCESS_REVOKED',
        {
          context,
          reason,
          metadata: { storeId },
        },
      );

      return transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: USER_SELECT,
      });
    });

    return this.toResponse(user);
  }

  async resetPassword(
    userId: string,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<{ temporaryPassword: string; mustChangePassword: true }> {
    if (userId === actor.userId) {
      throw new ForbiddenException('Use change-password for your own account.');
    }

    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = await hash(temporaryPassword, 12);

    await this.prisma.$transaction(async (transaction) => {
      await this.findUserInTransaction(transaction, userId);
      await transaction.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: null,
        },
      });
      await transaction.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'PASSWORD_RESET' },
      });
      await this.audit(
        transaction,
        actor.userId,
        userId,
        'USER_PASSWORD_RESET',
        {
          context,
          reason,
        },
      );
    });

    return { temporaryPassword, mustChangePassword: true };
  }

  async revokeSessions(
    userId: string,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.findUserInTransaction(transaction, userId);
      const result = await transaction.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'ADMIN_REVOKED' },
      });
      await this.audit(
        transaction,
        actor.userId,
        userId,
        'USER_SESSIONS_REVOKED',
        {
          context,
          reason,
          metadata: { revokedSessions: result.count },
        },
      );
    });
  }

  private async protectLastSuperAdmin(
    transaction: Prisma.TransactionClient,
    targetUserId: string,
  ): Promise<void> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('gami:last-super-admin'))`;
    const targetHasRole = await transaction.userRole.count({
      where: { userId: targetUserId, role: { code: 'SUPER_ADMIN' } },
    });

    if (!targetHasRole) {
      return;
    }

    const activeSuperAdmins = await transaction.user.count({
      where: {
        status: UserStatus.ACTIVE,
        deletedAt: null,
        roles: { some: { role: { code: 'SUPER_ADMIN' } } },
      },
    });

    if (activeSuperAdmins <= 1) {
      throw new BadRequestException(
        'The last active SUPER_ADMIN cannot be blocked or demoted.',
      );
    }
  }

  private async findUser(userId: string): Promise<SelectedUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SELECT,
    });

    if (!user) {
      throw new NotFoundException('User was not found.');
    }

    return user;
  }

  private async findUserInTransaction(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<SelectedUser> {
    const user = await transaction.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SELECT,
    });

    if (!user) {
      throw new NotFoundException('User was not found.');
    }

    return user;
  }

  private async audit(
    transaction: Prisma.TransactionClient,
    actorUserId: string,
    targetUserId: string,
    action: string,
    input: {
      context: RequestContext;
      fromState?: string;
      toState?: string;
      reason?: string;
      metadata?: Record<string, string | number | boolean>;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        actorUserId,
        entityType: 'user',
        entityId: targetUserId,
        action,
        fromState: input.fromState,
        toState: input.toState,
        reason: input.reason,
        channel: 'ADMIN_PANEL',
        metadata: {
          ipAddress: input.context.ipAddress ?? 'unknown',
          userAgent: input.context.userAgent ?? 'unknown',
          ...input.metadata,
        },
      },
    });
  }

  private toResponse(user: SelectedUser): UserResponseDto {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      phone: user.phone,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roles: user.roles.map(({ role }) => role.code),
      storeMemberships: user.storeMemberships.map((membership) => ({
        storeId: membership.storeId,
        storeName: membership.store.displayName,
        isOwner: membership.isOwner,
        active: membership.active,
      })),
    };
  }

  private generateTemporaryPassword(): string {
    return randomBytes(18).toString('base64url');
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
