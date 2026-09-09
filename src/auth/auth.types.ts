export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
  username: string;
  displayName: string;
  roles: string[];
  storeIds: string[];
  mustChangePassword: boolean;
}

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  type: 'access';
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}
