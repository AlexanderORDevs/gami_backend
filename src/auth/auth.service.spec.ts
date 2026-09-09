import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service.js';
import { AuthService } from './auth.service.js';

const userId = '9c92aa19-9934-4303-b25a-ec2acdb98816';
const sessionId = '711f030a-02bc-47e2-8142-1677974b3d04';

function userRecord(passwordHash: string) {
  return {
    id: userId,
    username: 'alexander',
    displayName: 'Alexander',
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
  const userUpdate = vi.fn();
  const auditCreate = vi.fn();
  const userFindUnique = vi.fn();
  const transaction = {
    authSession: { create: sessionCreate },
    user: { update: userUpdate },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    user: { findUnique: userFindUnique },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('signed-access-token') };
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
});
