# User administration

## Purpose

This module allows a super administrator to manage platform identities, roles, store scope, temporary credentials, sessions, and user audit history. It does not authenticate requests itself; it builds on the authentication module and the existing `users`, `roles`, `user_roles`, `store_members`, `auth_sessions`, and `audit_log` tables.

Every route requires:

```ts
@UseGuards(JwtAuthGuard, PasswordChangedGuard, RolesGuard)
@Roles('SUPER_ADMIN')
```

The caller must therefore have an active database session, a permanent password, and the `SUPER_ADMIN` role.

## API contract

| Method   | Route                                      | Purpose                                                         |
| -------- | ------------------------------------------ | --------------------------------------------------------------- |
| `GET`    | `/api/admin/roles`                         | List roles available for assignment.                            |
| `GET`    | `/api/admin/users`                         | List active records with pagination, search, and status filter. |
| `POST`   | `/api/admin/users`                         | Create a user and return a one-time temporary password.         |
| `GET`    | `/api/admin/users/:userId`                 | Return identity, roles, and store memberships.                  |
| `GET`    | `/api/admin/users/:userId/audit-log`       | Return immutable user audit history with pagination.            |
| `PATCH`  | `/api/admin/users/:userId/status`          | Activate, suspend, or disable a user.                           |
| `POST`   | `/api/admin/users/:userId/roles`           | Grant a role by stable role code.                               |
| `DELETE` | `/api/admin/users/:userId/roles/:roleCode` | Revoke a role and invalidate active sessions.                   |
| `POST`   | `/api/admin/users/:userId/stores`          | Grant, reactivate, or update membership in a store.             |
| `DELETE` | `/api/admin/users/:userId/stores/:storeId` | Deactivate membership and invalidate active sessions.           |
| `POST`   | `/api/admin/users/:userId/reset-password`  | Generate a one-time temporary password and revoke sessions.     |
| `DELETE` | `/api/admin/users/:userId/sessions`        | Revoke every active session for a user.                         |

Swagger publishes request and response contracts at `/docs`.

## User creation

A new user starts as `ACTIVE` with `must_change_password = true`. The service generates 18 random bytes and returns their 24-character base64url representation once. PostgreSQL receives only the bcrypt hash.

The caller must deliver the temporary password through an approved secure channel. It must not be placed in logs, tickets, audit metadata, email templates without transport protection, or analytics events.

Creating a user does not automatically assign a role or store. Those assignments are separate audited operations, preventing hidden defaults and allowing the administration UI to show each completed step explicitly.

## Role and store scope

Roles and store memberships answer different questions:

- A role defines **what** a user can do.
- A store membership defines **where** a store operator can do it.

Granting `STORE_OPERATOR` without a store membership gives no store scope. Granting a store membership without the appropriate role does not grant business permissions. Future store endpoints must enforce both `RolesGuard` and membership in `AuthenticatedUser.storeIds`.

Membership revocation sets `store_members.active = false` rather than deleting the row. Re-granting access reactivates the same membership and updates `is_owner`.

## Last administrator protection

The module prevents two forms of accidental platform lockout:

- A super administrator cannot suspend or disable their own account.
- A super administrator cannot revoke their own `SUPER_ADMIN` role.
- A user who is the last active `SUPER_ADMIN` cannot be blocked or demoted.

The last-admin count runs after acquiring the PostgreSQL transaction advisory lock identified by `gami:last-super-admin`. This serializes concurrent demotion and suspension attempts so two requests cannot both observe another active administrator and remove both.

## Session invalidation

Security-reducing changes revoke all active sessions belonging to the target user:

- Suspension or disabling.
- Role revocation.
- Store membership revocation.
- Administrative password reset.
- Explicit session revocation.

Role grants and store grants do not require revocation because `JwtAuthGuard` reads current roles and active memberships from PostgreSQL on every protected request.

## Required reasons

Status changes, role grants/revocations, store grants/revocations, password resets, and session revocation require a human-readable `reason`. This value is persisted in `audit_log.reason` and should explain the business decision, not repeat the action name.

Good example:

```text
Store ownership verified during onboarding case GAM-184.
```

Poor example:

```text
Grant role.
```

## Audit events

| Action                      | Meaning                                                |
| --------------------------- | ------------------------------------------------------ |
| `USER_CREATED`              | A new platform identity was created.                   |
| `USER_STATUS_CHANGED`       | Status changed between active, suspended, or disabled. |
| `USER_ROLE_GRANTED`         | A reusable role was assigned.                          |
| `USER_ROLE_REVOKED`         | A role was removed and sessions were invalidated.      |
| `USER_STORE_ACCESS_GRANTED` | Store membership was created, reactivated, or updated. |
| `USER_STORE_ACCESS_REVOKED` | Store membership was deactivated.                      |
| `USER_PASSWORD_RESET`       | A new temporary credential was generated.              |
| `USER_SESSIONS_REVOKED`     | Active sessions were administratively invalidated.     |

All mutations and their audit events execute in the same Prisma transaction. The business change rolls back if its audit write fails. Audit metadata contains request IP, user agent, and non-secret identifiers relevant to the action. It never contains passwords or tokens.

## Response policy

User responses expose operational profile data, role codes, and store memberships. They never select or serialize:

- `password_hash`.
- Refresh-token hashes.
- Raw access or refresh tokens.
- Internal session records.

Temporary passwords appear only in the immediate create/reset response.

## Pagination

User and audit lists use `page` and `limit`. Defaults are page 1 and 20 items; the maximum page size is 100. User search performs case-insensitive matching on username, display name, and email, plus phone matching.

## Future work

- Add permission-level policies if the fixed role set becomes too broad.
- Add an administration UI with explicit confirmation for security-reducing operations.
- Add notifications for account status, role, password-reset, and session changes.
- Add export and retention controls for audit history.
- Add maker-checker approval for highly sensitive finance role grants if required.
