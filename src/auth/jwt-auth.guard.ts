import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import type { AccessTokenPayload, AuthenticatedUser } from './auth.types.js';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const [scheme, token] = authorization?.split(' ') ?? [];

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('A valid bearer token is required.');
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });

      if (payload.type !== 'access' || !payload.sub || !payload.sid) {
        throw new UnauthorizedException('Invalid access token.');
      }

      const session = await this.prisma.authSession.findUnique({
        where: { id: payload.sid },
        include: {
          user: {
            include: {
              roles: { include: { role: true } },
              storeMemberships: { where: { active: true } },
            },
          },
        },
      });

      if (
        session?.userId !== payload.sub ||
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        session.user.status !== 'ACTIVE' ||
        session.user.deletedAt
      ) {
        throw new UnauthorizedException('The session is no longer active.');
      }

      request.user = {
        userId: session.user.id,
        sessionId: session.id,
        username: session.user.username,
        displayName: session.user.displayName,
        roles: session.user.roles.map(({ role }) => role.code),
        storeIds: session.user.storeMemberships.map(({ storeId }) => storeId),
        mustChangePassword: session.user.mustChangePassword,
      };

      return true;
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }
}
