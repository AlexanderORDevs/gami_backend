import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { PasswordResetMailer } from './password-reset-mailer.service.js';
import type {
  AuthResponseDto,
  AuthUserDto,
  ChangePasswordDto,
  LoginDto,
  PasswordChangeResponseDto,
  RecoverPasswordDto,
} from './dto/auth.dto.js';
import type { AuthenticatedUser, RequestContext } from './auth.types.js';

const INVALID_CREDENTIALS = 'Invalid username or password.';
const DUMMY_PASSWORD_HASH = await hash(randomUUID(), 12);

@Injectable()
export class AuthService {
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlDays: number;
  private readonly jwtSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
    private readonly passwordResetMailer: PasswordResetMailer,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
    this.accessTokenTtlSeconds = this.positiveInteger(
      config.get<string>('JWT_ACCESS_TTL_SECONDS', '900'),
      'JWT_ACCESS_TTL_SECONDS',
    );
    this.refreshTokenTtlDays = this.positiveInteger(
      config.get<string>('AUTH_REFRESH_TTL_DAYS', '7'),
      'AUTH_REFRESH_TTL_DAYS',
    );

    if (this.jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must contain at least 32 characters.');
    }
  }

  async login(
    input: LoginDto,
    context: RequestContext,
  ): Promise<AuthResponseDto> {
    const username = input.username.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: this.userAccessInclude(),
    });
    const passwordMatches = await compare(
      input.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      if (user) {
        await this.writeAudit(user.id, 'AUTH_LOGIN_FAILED', context, {
          reason: 'INVALID_PASSWORD',
        });
      }

      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.status !== 'ACTIVE' || user.deletedAt) {
      await this.writeAudit(user.id, 'AUTH_LOGIN_BLOCKED', context, {
        reason: user.deletedAt ? 'DELETED_USER' : user.status,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const rawRefreshToken = this.createRefreshToken();
    const now = new Date();
    const expiresAt = this.refreshExpiry(now);
    const session = await this.prisma.$transaction(async (transaction) => {
      const createdSession = await transaction.authSession.create({
        data: {
          userId: user.id,
          familyId: randomUUID(),
          tokenHash: this.hashToken(rawRefreshToken),
          expiresAt,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
      });

      await transaction.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          action: 'AUTH_LOGIN_SUCCEEDED',
          channel: 'API',
          metadata: this.auditMetadata(context),
        },
      });

      return createdSession;
    });

    return this.buildAuthResponse(user, session.id, rawRefreshToken);
  }

  async refresh(
    rawRefreshToken: string,
    context: RequestContext,
  ): Promise<AuthResponseDto> {
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: this.hashToken(rawRefreshToken) },
      include: { user: { include: this.userAccessInclude() } },
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    if (session.revokedAt) {
      await this.prisma.$transaction([
        this.prisma.authSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: 'TOKEN_REUSE' },
        }),
        this.prisma.auditLog.create({
          data: {
            actorUserId: session.userId,
            entityType: 'user',
            entityId: session.userId,
            action: 'AUTH_REFRESH_REUSE_DETECTED',
            channel: 'API',
            metadata: this.auditMetadata(context),
          },
        }),
      ]);
      throw new UnauthorizedException('The refresh token has been revoked.');
    }

    if (
      session.expiresAt <= new Date() ||
      session.user.status !== 'ACTIVE' ||
      session.user.deletedAt
    ) {
      await this.prisma.authSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokeReason: 'EXPIRED_OR_BLOCKED' },
      });
      throw new UnauthorizedException('The refresh token is no longer valid.');
    }

    const nextRefreshToken = this.createRefreshToken();
    const now = new Date();
    const nextSession = await this.prisma.$transaction(async (transaction) => {
      await transaction.authSession.update({
        where: { id: session.id },
        data: {
          lastUsedAt: now,
          revokedAt: now,
          revokeReason: 'ROTATED',
        },
      });
      const createdSession = await transaction.authSession.create({
        data: {
          userId: session.userId,
          familyId: session.familyId,
          tokenHash: this.hashToken(nextRefreshToken),
          expiresAt: this.refreshExpiry(now),
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: session.userId,
          entityType: 'user',
          entityId: session.userId,
          action: 'AUTH_TOKEN_REFRESHED',
          channel: 'API',
          metadata: this.auditMetadata(context),
        },
      });

      return createdSession;
    });

    return this.buildAuthResponse(
      session.user,
      nextSession.id,
      nextRefreshToken,
    );
  }

  async logout(
    user: AuthenticatedUser,
    context: RequestContext,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.authSession.updateMany({
        where: { id: user.sessionId, userId: user.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'LOGOUT' },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: user.userId,
          entityType: 'user',
          entityId: user.userId,
          action: 'AUTH_LOGOUT',
          channel: 'API',
          metadata: this.auditMetadata(context),
        },
      });
    });
  }

  async changePassword(
    principal: AuthenticatedUser,
    input: ChangePasswordDto,
    context: RequestContext,
  ): Promise<PasswordChangeResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      include: this.userAccessInclude(),
    });

    if (!user) {
      throw new UnauthorizedException('The current password is incorrect.');
    }

    if (
      !principal.mustChangePassword &&
      (!input.currentPassword ||
        !(await compare(input.currentPassword, user.passwordHash)))
    ) {
      await this.writeAudit(user.id, 'AUTH_PASSWORD_CHANGE_FAILED', context, {
        reason: 'INVALID_CURRENT_PASSWORD',
      });
      throw new UnauthorizedException('The current password is incorrect.');
    }

    if (await compare(input.newPassword, user.passwordHash)) {
      await this.writeAudit(user.id, 'AUTH_PASSWORD_CHANGE_REJECTED', context, {
        reason: 'PASSWORD_REUSE',
      });
      throw new BadRequestException('The new password must be different.');
    }

    const passwordHash = await hash(input.newPassword, 12);
    const rawRefreshToken = this.createRefreshToken();
    const recoveryCodes = this.createRecoveryCodes();
    const now = new Date();
    const session = await this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: now,
        },
      });
      await transaction.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'PASSWORD_CHANGED' },
      });
      await this.replaceRecoveryCodes(transaction, user.id, recoveryCodes, now);
      const createdSession = await transaction.authSession.create({
        data: {
          userId: user.id,
          familyId: randomUUID(),
          tokenHash: this.hashToken(rawRefreshToken),
          expiresAt: this.refreshExpiry(now),
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          action: 'AUTH_PASSWORD_CHANGED',
          channel: 'API',
          metadata: this.auditMetadata(context),
        },
      });

      return createdSession;
    });

    return {
      ...(await this.buildAuthResponse(
        { ...user, mustChangePassword: false },
        session.id,
        rawRefreshToken,
      )),
      recoveryCodes,
    };
  }

  async requestPasswordReset(
    email: string,
    context: RequestContext,
  ): Promise<{ message: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, status: true, deletedAt: true },
    });
    const response = {
      message:
        'If an active account uses that email, a reset code has been sent.',
    };

    if (!user?.email || user.status !== 'ACTIVE' || user.deletedAt) {
      return response;
    }

    const now = new Date();
    const recentRequest = await this.prisma.passwordRecoveryCode.findFirst({
      where: {
        userId: user.id,
        purpose: 'EMAIL_RESET',
        usedAt: null,
        createdAt: { gt: new Date(now.getTime() - 60_000) },
      },
      select: { id: true },
    });
    if (recentRequest) return response;

    const recoveryCode = this.createEmailResetCode();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const created = await this.prisma.$transaction(async (transaction) => {
      await transaction.passwordRecoveryCode.updateMany({
        where: {
          userId: user.id,
          purpose: 'EMAIL_RESET',
          usedAt: null,
        },
        data: { usedAt: now },
      });
      return transaction.passwordRecoveryCode.create({
        data: {
          userId: user.id,
          codeHash: this.hashToken(recoveryCode),
          purpose: 'EMAIL_RESET',
          expiresAt,
        },
      });
    });

    try {
      await this.passwordResetMailer.send(user.email, recoveryCode);
    } catch (error) {
      await this.prisma.passwordRecoveryCode.update({
        where: { id: created.id },
        data: { usedAt: new Date() },
      });
      throw error;
    }

    await this.writeAudit(user.id, 'AUTH_PASSWORD_RESET_REQUESTED', context, {
      delivery: 'EMAIL',
    });
    return response;
  }

  async recoverPassword(
    input: RecoverPasswordDto,
    context: RequestContext,
  ): Promise<PasswordChangeResponseDto> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const codeHash = this.hashToken(input.recoveryCode.trim().toUpperCase());
    const recovery = await this.prisma.passwordRecoveryCode.findUnique({
      where: { codeHash },
      include: { user: { include: this.userAccessInclude() } },
    });
    const now = new Date();

    if (
      recovery?.purpose !== 'EMAIL_RESET' ||
      recovery.usedAt ||
      recovery.expiresAt <= now ||
      recovery.user.email?.toLowerCase() !== normalizedEmail ||
      recovery.user.status !== 'ACTIVE' ||
      recovery.user.deletedAt
    ) {
      throw new UnauthorizedException('Invalid or expired recovery code.');
    }

    if (await compare(input.newPassword, recovery.user.passwordHash)) {
      throw new BadRequestException('The new password must be different.');
    }

    const passwordHash = await hash(input.newPassword, 12);
    const rawRefreshToken = this.createRefreshToken();
    const nextRecoveryCodes = this.createRecoveryCodes();
    const session = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.passwordRecoveryCode.updateMany({
        where: { id: recovery.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw new UnauthorizedException('Invalid or expired recovery code.');
      }

      await transaction.user.update({
        where: { id: recovery.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: now,
        },
      });
      await transaction.authSession.updateMany({
        where: { userId: recovery.userId, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'PASSWORD_RECOVERED' },
      });
      await this.replaceRecoveryCodes(
        transaction,
        recovery.userId,
        nextRecoveryCodes,
        now,
      );
      const createdSession = await transaction.authSession.create({
        data: {
          userId: recovery.userId,
          familyId: randomUUID(),
          tokenHash: this.hashToken(rawRefreshToken),
          expiresAt: this.refreshExpiry(now),
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: recovery.userId,
          entityType: 'user',
          entityId: recovery.userId,
          action: 'AUTH_PASSWORD_RECOVERED',
          channel: 'API',
          metadata: this.auditMetadata(context),
        },
      });
      return createdSession;
    });

    return {
      ...(await this.buildAuthResponse(
        { ...recovery.user, mustChangePassword: false },
        session.id,
        rawRefreshToken,
      )),
      recoveryCodes: nextRecoveryCodes,
    };
  }

  getProfile(user: AuthenticatedUser): AuthUserDto {
    return {
      id: user.userId,
      username: user.username,
      displayName: user.displayName,
      roles: user.roles,
      storeIds: user.storeIds,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private async buildAuthResponse(
    user: {
      id: string;
      username: string;
      displayName: string;
      mustChangePassword: boolean;
      roles: Array<{ role: { code: string } }>;
      storeMemberships: Array<{ storeId: string }>;
    },
    sessionId: string,
    refreshToken: string,
  ): Promise<AuthResponseDto> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, type: 'access' },
      { secret: this.jwtSecret, expiresIn: this.accessTokenTtlSeconds },
    );

    return {
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: this.accessTokenTtlSeconds,
      },
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        roles: user.roles.map(({ role }) => role.code),
        storeIds: user.storeMemberships.map(({ storeId }) => storeId),
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  private createRecoveryCodes(): string[] {
    return Array.from(
      { length: 5 },
      () => `GAMI-${randomBytes(12).toString('hex').toUpperCase()}`,
    );
  }

  private createEmailResetCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(10);
    const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
    return `GAMI-${code.slice(0, 5).join('')}-${code.slice(5).join('')}`;
  }

  private async replaceRecoveryCodes(
    transaction: Prisma.TransactionClient,
    userId: string,
    recoveryCodes: string[],
    now: Date,
  ): Promise<void> {
    await transaction.passwordRecoveryCode.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
    const expiresAt = new Date(now);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
    await transaction.passwordRecoveryCode.createMany({
      data: recoveryCodes.map((code) => ({
        userId,
        codeHash: this.hashToken(code),
        purpose: 'BACKUP',
        expiresAt,
      })),
    });
  }

  private async writeAudit(
    userId: string,
    action: string,
    context: RequestContext,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        entityType: 'user',
        entityId: userId,
        action,
        channel: 'API',
        metadata: { ...this.auditMetadata(context), ...metadata },
      },
    });
  }

  private userAccessInclude() {
    return {
      roles: { include: { role: true } },
      storeMemberships: { where: { active: true } },
    } as const;
  }

  private auditMetadata(context: RequestContext): Record<string, string> {
    return {
      ipAddress: context.ipAddress ?? 'unknown',
      userAgent: context.userAgent ?? 'unknown',
    };
  }

  private createRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private refreshExpiry(from: Date): Date {
    return new Date(
      from.getTime() + this.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );
  }

  private positiveInteger(value: string, name: string): number {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }

    return parsed;
  }
}
