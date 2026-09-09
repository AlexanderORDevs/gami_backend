# Authentication and authorization

## Purpose

This module authenticates platform users, maintains revocable sessions, exposes the current authorization context, and records security-relevant activity in `audit_log`.

Administrative user, role, store-scope, password-reset, and session-revocation workflows are documented in [../users/README.md](../users/README.md).

## API contract

| Method | Route                       | Authentication      | Purpose                                                                           |
| ------ | --------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `POST` | `/api/auth/login`           | Public              | Validate credentials and create a new session.                                    |
| `POST` | `/api/auth/refresh`         | Refresh token body  | Rotate the refresh token and issue a new access token.                            |
| `POST` | `/api/auth/logout`          | Bearer access token | Revoke the current session.                                                       |
| `POST` | `/api/auth/change-password` | Bearer access token | Replace the password, revoke all prior sessions, and issue a new session.         |
| `GET`  | `/api/auth/me`              | Bearer access token | Return the current identity, roles, store scope, and password-change requirement. |

Interactive API documentation is available at `/docs`.

## Token model

The access token is a short-lived signed JWT containing only:

- `sub`: user UUID.
- `sid`: database session UUID.
- `type`: always `access`.
- Standard JWT issue and expiration claims.

Roles and store memberships are not trusted from token claims. `JwtAuthGuard` loads the current session, user status, roles, and active store memberships from PostgreSQL on every protected request. This means logout, suspension, membership removal, and role changes take effect without waiting for JWT expiration.

The refresh token is 48 random bytes encoded as base64url. Only its SHA-256 hash is stored in `auth_sessions`. Every successful refresh:

1. Revokes the presented session row with reason `ROTATED`.
2. Creates a replacement row in the same token family.
3. Issues a new access token and a new refresh token.
4. Writes `AUTH_TOKEN_REFRESHED` to `audit_log`.

If an already-revoked refresh token is presented, the module treats it as possible theft, revokes every active session in that family, and writes `AUTH_REFRESH_REUSE_DETECTED`.

## Temporary passwords

Seeded accounts set `must_change_password = true`. Login remains possible so the user can reach the change-password workflow, but clients must redirect that user to password replacement before allowing normal application work.

The new password requires at least 12 characters. A successful change:

- Replaces the bcrypt password hash.
- Sets `must_change_password = false` and `password_changed_at`.
- Revokes every prior session for the user.
- Creates a fresh session and token family.
- Writes `AUTH_PASSWORD_CHANGED` to `audit_log`.

Future protected business modules should reject normal operations while `mustChangePassword` is true. The authentication routes remain available to permit remediation.

## Authorization usage

Use both guards and declare one or more accepted roles:

```ts
@UseGuards(JwtAuthGuard, PasswordChangedGuard, RolesGuard)
@Roles('CATALOG_MANAGER')
```

`PasswordChangedGuard` blocks business operations while a temporary password remains active. `SUPER_ADMIN` satisfies every `RolesGuard` check. Other users need at least one declared role. Store-owned resources must additionally verify that the resource store ID appears in `AuthenticatedUser.storeIds`; a role alone does not grant access to every store.

## Audit events

| Action                          | Written when                                                           |
| ------------------------------- | ---------------------------------------------------------------------- |
| `AUTH_LOGIN_SUCCEEDED`          | Valid credentials create a session.                                    |
| `AUTH_LOGIN_FAILED`             | A known username supplies an invalid password.                         |
| `AUTH_LOGIN_BLOCKED`            | Credentials are valid but the user is suspended, disabled, or deleted. |
| `AUTH_TOKEN_REFRESHED`          | A refresh token rotates successfully.                                  |
| `AUTH_REFRESH_REUSE_DETECTED`   | A revoked token is presented again and its family is invalidated.      |
| `AUTH_LOGOUT`                   | The current session is revoked.                                        |
| `AUTH_PASSWORD_CHANGED`         | Password replacement and global session revocation succeed.            |
| `AUTH_PASSWORD_CHANGE_FAILED`   | An authenticated user supplies an incorrect current password.          |
| `AUTH_PASSWORD_CHANGE_REJECTED` | The proposed password violates a business rule such as password reuse. |

Unknown usernames are not written to `audit_log` because that table requires a valid UUID entity and recording arbitrary input there would enable unbounded unauthenticated writes. Infrastructure logs and rate-limit telemetry should cover unknown-account attempts without exposing whether an account exists.

Audit metadata currently includes normalized request IP and user agent. It never contains passwords, raw refresh tokens, access tokens, or password hashes.

## Configuration

| Variable                 | Purpose                                                                | Development default         |
| ------------------------ | ---------------------------------------------------------------------- | --------------------------- |
| `JWT_SECRET`             | Signs and verifies access tokens. Must contain at least 32 characters. | No safe production default. |
| `JWT_ACCESS_TTL_SECONDS` | Access-token lifetime.                                                 | `900`                       |
| `AUTH_REFRESH_TTL_DAYS`  | Refresh-session lifetime.                                              | `7`                         |

Rotate `JWT_SECRET` through the deployment secret manager. Changing it invalidates every issued access token. Database sessions should also be revoked during a deliberate key rotation.

## Security boundaries

- Responses use the same invalid-credentials message for unknown users and wrong passwords.
- A dummy bcrypt comparison reduces username timing differences.
- User status and session revocation are checked on every protected request.
- Refresh tokens are opaque, hashed, rotated, and family-revoked on replay.
- DTO validation rejects unknown request properties.
- Passwords and tokens are never written to audit metadata.
- Production must use HTTPS and rate-limit login and refresh endpoints.
- If the API is deployed behind a proxy, configure trusted proxies explicitly before relying on forwarded client IP headers.

## Future work

- Add distributed rate limiting and account lockout telemetry with Redis.
- Deliver refresh tokens in `HttpOnly`, `Secure`, `SameSite` cookies when the frontend deployment topology is final.
- Add password recovery and verified email/phone flows.
- Add second-factor authentication for privileged roles.
- Define retention and anonymization periods for session IP and user-agent data.
