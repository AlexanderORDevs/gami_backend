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

Creation accepts an optional `storeId` (UUID), `isOwner` (boolean, default false), and `storeRole` (`StoreMemberRole`). Selecting a store creates an active membership and grants the legacy `STORE_OPERATOR` account role in the same transaction as the account and audit events. The membership role defaults to `STORE_ADMIN` for an owner, otherwise `STORE_OPERATOR`; an explicit `storeRole` takes precedence. Ownership is business metadata, not a continuing permission override. The store must exist and not be soft-deleted; the legacy system role must exist. A failed assignment rolls back the entire creation. Ownership or a store role without a store is rejected.

Without `storeId`, no role or membership is assigned. The administration form offers a searchable, paginated store selector with a "Sin tienda" option. Later assignments remain available as separate audited operations.

## Role and store scope

Roles and store memberships answer different questions:

- A global role defines platform-wide authority. Only `SUPER_ADMIN` can access the platform user-management routes and grant another global `SUPER_ADMIN`.
- A store membership defines **where** the user operates; its `role` defines **what** they can do in that store. The same person can have different roles in different stores.

`/api/store-workspace/stores` lists only current active memberships (or all stores for a platform superadmin). Every store route checks the current database membership, active flag, nondeleted store, and resource permission using `StoreAccessService`. Global role names such as `STORE_ADMIN` or client-provided store IDs do not substitute for membership. Permission changes apply to the next request, including requests using existing tokens.

| Membership role   | Store modules                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `STORE_ADMIN`     | Catalog, inventory, attention/orders, shipments, payouts, ledger, profile, team creation and role delegation. |
| `STORE_OPERATOR`  | Catalog, inventory, attention/orders, shipments, profile.                                                     |
| `STORE_CATALOG`   | Catalog, inventory, profile.                                                                                  |
| `STORE_ATTENTION` | Catalog, attention/orders, profile.                                                                           |
| `STORE_LOGISTICS` | Inventory, attention/orders, shipments, profile.                                                              |
| `STORE_FINANCE`   | Payouts, ledger, profile.                                                                                     |

The store portal exposes the existing information modules as read-only views. Catalog includes unpublished products from that store. Attention lists only that store's order items and subtotal, not the entire customer order or other stores' amounts. Inventory includes variant stock, with unknown inventory represented as null. Shipment projections exclude other stores' items and financial data. This change does not add order confirmation, catalog editing, payment execution, or outbound messaging.

Store administrators can create users and other store administrators through `POST /api/store-workspace/stores/:storeId/members`, and change roles or revoke/reactivate their existing members through `PATCH /api/store-workspace/stores/:storeId/members/:userId`. Those routes never accept global roles, arbitrary store assignments, password resets of existing users, or global account suspension. The last active store administrator is protected by a per-store advisory lock. Store staff cannot use platform administration routes.

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

Role grants and store grants do not require revocation because `JwtAuthGuard` reads current roles and active memberships from PostgreSQL on every protected request. Store-scoped role changes/revocations also take effect immediately through `StoreAccessService`, without logging the person out of unrelated stores.

## Required reasons

Status changes, role grants/revocations, store grants/revocations, password resets, and session revocation require a human-readable `reason`. This value is persisted in `audit_log.reason` and should explain the business decision, not repeat the action name.

The optional initial assignment records the account-creation context as its reason and the explicitly selected store and ownership in audit metadata. Subsequent role and membership changes still require the administrator's reason.

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
| `USER_STORE_ROLE_CHANGED`   | Store-scoped role or active access changed.            |
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

## Verification

Run the focused users, store-access, and store-workspace Vitest suites. `RUN_USERS_INTEGRATION=1` enables local PostgreSQL user-creation tests. `RUN_STORE_WORKSPACE_INTEGRATION=1` enables HTTP tests with real JWT sessions, membership changes, cross-store denial, global-role escalation denial, and last-admin protection. Integration fixtures run in an outer transaction and are rolled back; both tests refuse non-loopback databases. Apply migrations and generate the Prisma client first.

## Future work

- Add permission-level policies if the fixed role set becomes too broad.
- Add an administration UI with explicit confirmation for security-reducing operations.
- Add notifications for account status, role, password-reset, and session changes.
- Add export and retention controls for audit history.
- Add maker-checker approval for highly sensitive finance role grants if required.
