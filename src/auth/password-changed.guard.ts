import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from './auth.types.js';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class PasswordChangedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new ForbiddenException('Authentication context is required.');
    }

    if (request.user.mustChangePassword) {
      throw new ForbiddenException(
        'The temporary password must be changed before continuing.',
      );
    }

    return true;
  }
}
