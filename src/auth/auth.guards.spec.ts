import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from './auth.types.js';
import { PasswordChangedGuard } from './password-changed.guard.js';
import { RolesGuard } from './roles.guard.js';

function executionContext(user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => executionContext,
    getClass: () => PasswordChangedGuard,
  } as unknown as ExecutionContext;
}

const activeUser: AuthenticatedUser = {
  userId: '9c92aa19-9934-4303-b25a-ec2acdb98816',
  sessionId: '711f030a-02bc-47e2-8142-1677974b3d04',
  username: 'operator',
  displayName: 'Operator',
  roles: ['CATALOG_MANAGER'],
  storeIds: [],
  mustChangePassword: false,
};

describe('authentication guards', () => {
  it('blocks business routes while a temporary password is active', () => {
    const guard = new PasswordChangedGuard();
    const user = { ...activeUser, mustChangePassword: true };

    expect(() => guard.canActivate(executionContext(user))).toThrow(
      ForbiddenException,
    );
  });

  it('allows a user with one of the required roles', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['CATALOG_MANAGER']),
    };
    const guard = new RolesGuard(reflector as unknown as Reflector);

    expect(guard.canActivate(executionContext(activeUser))).toBe(true);
  });

  it('allows SUPER_ADMIN to satisfy every role requirement', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['FINANCE_MANAGER']),
    };
    const guard = new RolesGuard(reflector as unknown as Reflector);
    const superAdmin = { ...activeUser, roles: ['SUPER_ADMIN'] };

    expect(guard.canActivate(executionContext(superAdmin))).toBe(true);
  });

  it('rejects a user without a required role', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['FINANCE_MANAGER']),
    };
    const guard = new RolesGuard(reflector as unknown as Reflector);

    expect(() => guard.canActivate(executionContext(activeUser))).toThrow(
      ForbiddenException,
    );
  });
});
