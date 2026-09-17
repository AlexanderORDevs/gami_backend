import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service.js';
import { AuthService } from './auth.service.js';
import { PasswordResetMailer } from './password-reset-mailer.service.js';

const userId = '9c92aa19-9934-4303-b25a-ec2acdb98816';
const sessionId = '711f030a-02bc-47e2-8142-1677974b3d04';

function userRecord(passwordHash: string) {
  return {
    id: userId,
    username: 'alexander',
    displayName: 'Alexander',
    email: 'alexander@example.com',
    passwordHash,
    mustChangePassword: true,
    passwordChangedAt: null,
    status: 'ACTIVE' as const,
    deletedAt: null,
    roles: [{ role: { code: 'SUPER_ADMIN' } }],
    storeMemberships: [],
  };
}

describe('AuthService', () => {
  const sessionCreate = vi.fn();
  const sessionUpdateMany = vi.fn();
  const recoveryFindUnique = vi.fn();
  const recoveryFindFirst = vi.fn();
  const recoveryUpdateMany = vi.fn();
  const recoveryCreate = vi.fn();
  const recoveryCreateMany = vi.fn();
  const recoveryUpdate = vi.fn();
  const userUpdate = vi.fn();
  const auditCreate = vi.fn();
  const userFindUnique = vi.fn();
  const transaction = {
    authSession: { create: sessionCreate, updateMany: sessionUpdateMany },
    passwordRecoveryCode: {
      updateMany: recoveryUpdateMany,
      create: recoveryCreate,
      createMany: recoveryCreateMany,
    },
    user: { update: userUpdate },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    user: { findUnique: userFindUnique },
    passwordRecoveryCode: {
      findUnique: recoveryFindUnique,
      findFirst: recoveryFindFirst,
      update: recoveryUpdate,
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('signed-access-token') };
  const mailer = { send: vi.fn().mockResolvedValue(undefined) };
  const config = {
    getOrThrow: vi
      .fn()
      .mockReturnValue('a-secure-test-secret-with-at-least-32-characters'),
    get: vi.fn((name: string, fallback: string) => {
      const values: Record<string, string> = {
        JWT_ACCESS_TTL_SECONDS: '900',
        AUTH_REFRESH_TTL_DAYS: '7',
      };
      return values[name] ?? fallback;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionCreate.mockResolvedValue({ id: sessionId });
    sessionUpdateMany.mockResolvedValue({ count: 1 });
    recoveryUpdateMany.mockResolvedValue({ count: 1 });
    recoveryFindFirst.mockResolvedValue(null);
    recoveryCreate.mockResolvedValue({
      id: '7a601792-cd20-4260-a917-9304150bc80f',
    });
    recoveryCreateMany.mockResolvedValue({ count: 5 });
    recoveryUpdate.mockResolvedValue({});
    userUpdate.mockResolvedValue({});
    auditCreate.mockResolvedValue({});
    jwt.signAsync.mockResolvedValue('signed-access-token');
  });

  it('creates a hashed refresh session and audit event on login', async () => {
    const passwordHash = await hash('temporary-password', 4);
    userFindUnique.mockResolvedValue(userRecord(passwordHash));
    const service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mailer as unknown as PasswordResetMailer,
    );

    const result = await service.login(
      { username: 'Alexander', password: 'temporary-password' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest' },
    );

    const sessionData = sessionCreate.mock.calls[0]?.[0]?.data as {
      tokenHash: string;
    };
    expect(sessionData.tokenHash).toHaveLength(64);
    expect(sessionData.tokenHash).not.toBe(result.tokens.refreshToken);
    expect(result.user).toMatchObject({
      username: 'alexander',
      roles: ['SUPER_ADMIN'],
      mustChangePassword: true,
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: userId,
        action: 'AUTH_LOGIN_SUCCEEDED',
        channel: 'API',
      }),
    });
  });

  it('completes a temporary password session without requesting it again', async () => {
    const passwordHash = await hash('temporary-password', 4);
    userFindUnique.mockResolvedValue(userRecord(passwordHash));
    const service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mailer as unknown as PasswordResetMailer,
    );

    const result = await service.changePassword(
      {
        userId,
        sessionId,
        username: 'alexander',
        displayName: 'Alexander',
        roles: ['SUPER_ADMIN'],
        storeIds: [],
        mustChangePassword: true,
      },
      { newPassword: 'a-new-secure-password' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest' },
    );

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: userId },
      data: expect.objectContaining({ mustChangePassword: false }),
    });
    expect(result.user.mustChangePassword).toBe(false);
  });

  it('requires the current password for an established account', async () => {
    const passwordHash = await hash('established-password', 4);
    userFindUnique.mockResolvedValue({
      ...userRecord(passwordHash),
      mustChangePassword: false,
    });
    const service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mailer as unknown as PasswordResetMailer,
    );

    await expect(
      service.changePassword(
        {
          userId,
          sessionId,
          username: 'alexander',
          displayName: 'Alexander',
          roles: ['SUPER_ADMIN'],
          storeIds: [],
          mustChangePassword: false,
        },
        { newPassword: 'a-new-secure-password' },
        { ipAddress: '127.0.0.1', userAgent: 'vitest' },
      ),
    ).rejects.toThrow('The current password is incorrect.');
  });

  it('consumes a recovery code and replaces it with new one-time codes', async () => {
    const passwordHash = await hash('established-password', 4);
    recoveryFindUnique.mockResolvedValue({
      id: '822962cf-76c4-4b75-aa5a-a7eb22b4f33a',
      userId,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      purpose: 'EMAIL_RESET',
      user: { ...userRecord(passwordHash), mustChangePassword: false },
    });
    const service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mailer as unknown as PasswordResetMailer,
    );

    const result = await service.recoverPassword(
      {
        email: 'alexander@example.com',
        recoveryCode: 'GAMI-1234567890ABCDEF12345678',
        newPassword: 'a-different-secure-password',
      },
      { ipAddress: '127.0.0.1', userAgent: 'vitest' },
    );

    expect(recoveryUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: '822962cf-76c4-4b75-aa5a-a7eb22b4f33a',
        usedAt: null,
      }),
      data: { usedAt: expect.any(Date) },
    });
    expect(recoveryCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ userId, codeHash: expect.any(String) }),
      ]),
    });
    expect(result.recoveryCodes).toHaveLength(5);
    expect(result.user.mustChangePassword).toBe(false);
  });

  it('emails a short-lived reset code for an active account', async () => {
    userFindUnique.mockResolvedValue({
      id: userId,
      email: 'alexander@example.com',
      status: 'ACTIVE',
      deletedAt: null,
    });
    const service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mailer as unknown as PasswordResetMailer,
    );

    const result = await service.requestPasswordReset(
      ' Alexander@example.com ',
      { ipAddress: '127.0.0.1', userAgent: 'vitest' },
    );

    expect(recoveryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId,
        purpose: 'EMAIL_RESET',
        codeHash: expect.any(String),
      }),
    });
    expect(mailer.send).toHaveBeenCalledWith(
      'alexander@example.com',
      expect.stringMatching(/^GAMI-[A-Z2-9]{5}-[A-Z2-9]{5}$/),
    );
    expect(result.message).not.toContain('alexander@example.com');
  });

  it('returns the same response for an email without an active account', async () => {
    userFindUnique.mockResolvedValue(null);
    const service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mailer as unknown as PasswordResetMailer,
    );

    const result = await service.requestPasswordReset('unknown@example.com', {
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(result.message).toBe(
      'If an active account uses that email, a reset code has been sent.',
    );
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('does not send another code during the reset cooldown', async () => {
    userFindUnique.mockResolvedValue({
      id: userId,
      email: 'alexander@example.com',
      status: 'ACTIVE',
      deletedAt: null,
    });
    recoveryFindFirst.mockResolvedValue({ id: 'recent-request' });
    const service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mailer as unknown as PasswordResetMailer,
    );

    await service.requestPasswordReset('alexander@example.com', {
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(recoveryCreate).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
