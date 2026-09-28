# Gami database foundation

PostgreSQL and the versioned Prisma migrations are the source of truth for the Gami marketplace data model.

For a table-by-table explanation of the schema, fields, relationships, lifecycle, and business purpose, see [DATABASE_DICTIONARY.md](DATABASE_DICTIONARY.md).

Authentication behavior, token rotation, authorization guards, and security audit events are documented in [../src/auth/README.md](../src/auth/README.md).

Administrative user and access workflows are documented in [../src/users/README.md](../src/users/README.md).

## Identity model

`users` stores identities and credentials. `roles` stores reusable permission groups. `user_roles` is the many-to-many assignment table: one user can perform several internal functions and one role can be assigned to several users. It also records who granted the role and when.

Store access is separate from permissions. `store_members` determines which stores a user can operate, while `user_roles` determines what that user is allowed to do.

## Functional areas

- Identity: `users`, `auth_sessions`, `roles`, `user_roles`, `store_members`.
- Catalog: `stores`, `store_hours`, `store_closures`, `products`, `product_attributes`, `variants`.
- Inventory: `inventory`, `stock_movements`, `stock_holds`, `stock_declarations`.
- Customers: `customers`, `addresses`, `customer_credits`, `user_events`.
- Sales: `orders`, `store_orders`, `order_items`, `payments`.
- Operations: `whatsapp_messages`, `shipments`, `fulfillment_exceptions`, `strikes`, `appeals`.
- Finance: `pending_settlements`, `payouts`, `ledger_entries`, `compensations`.
- Platform: `settings`, `logistics_calendar`, `shipping_rates`, `integration_events`, `audit_log`.

All relational identifiers use foreign keys. Historical order references use restrictive deletion rules. Catalog records referenced by history use soft deletion. Monetary values are integer cents and timestamps are stored in UTC.

## Integration boundary

`integration_events` is the idempotent inbox for payment, WhatsApp, and courier webhooks. Its `(provider, external_event_id)` unique key prevents processing the same provider event twice. Provider payloads are retained as JSONB for support and reconciliation.

The database is provider-neutral. These external decisions and credentials are still required before live traffic:

- Meta Cloud API or a WhatsApp BSP, an approved message template, and webhook credentials.
- A payment provider supporting cards, Yape, and Plin, including webhook signing credentials.
- A courier integration or a confirmed manual dispatch workflow.
- Object storage and CDN credentials for product images and evidence files.
- Redis for durable retries, stock-hold expiration, confirmation SLA jobs, and automatic strikes.
- Finance decisions DP-08, DP-09, and DP-10 for refund commission behavior, commission application, and settlement hold period.

## Commands

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
npm run db:verify
```

Production uses `npm run db:deploy` instead of `db:migrate`.

The seed is idempotent. Initial administrator credentials come from environment variables and must be changed after the first login. Existing administrator state, password, roles and setting values are preserved on subsequent deployments; missing default settings/roles are created. The seed also loads the versioned catalog and requires private store contacts when those stores do not yet exist. See [ONBOARDING.md](ONBOARDING.md#automatic-catalog-deployment-without-excel) before the first deployment to a new database. For a complete development-to-production replacement, use the separate procedure below and remove automatic seeding from the Render build.

## Full Development-To-Production Replacement

This is an explicit destructive operation, not a seed, migration or automatic synchronization. The owner approved replacing production data with development and invalidating sessions/recovery codes. All production-only records will be lost from the active database after a successful replacement; a private backup is mandatory and created first. No replacement has been performed while the production connection file is incomplete.

### Scope And Prerequisites

- Copies the complete application's `public` schema: every table (including future tables), data, relationships, UUIDs, sequences, constraints, enum types and Prisma migration history. This includes users/password hashes, roles, memberships, stores, products, stock, settings, financial/private intake data and audit history. It does not export PostgreSQL server roles, ownership or ACLs; restored objects belong to the destination connection role.
- Only `auth_sessions` and `password_recovery_codes` data are excluded; their structures remain. Source data is not changed. Users log in again with their existing development passwords and account flags, including any forced password-change requirement. No login/password policy is weakened, and JWT/SMTP/payment secrets are not copied from the local environment file.
- Short development passwords will work where their existing account state permits login, but are unsafe for a publicly reachable production application. Use strong passwords before exposing real accounts/data. Never commit password hashes, dumps, SQL backups or environment credentials to Git.
- Publication/status fields are copied literally. Development's local preview can show products that production will hide. The plan prints `sourcePublicProducts`; zero means the exact copy will not have publicly visible products. Do not silently activate stores, publish products or run the old seed to compensate; review a separate publication operation if needed.
- Requires PostgreSQL client tools compatible with the source and target (locally found at `C:\Program Files\PostgreSQL\18\bin`). This conservative workflow requires target PostgreSQL major >= source major. Additional user schemas, extensions or large objects are rejected for separate review. Both connections need backup access; the destination role must own/control `public` and its objects.

### Preparation

1. Keep `.env` pointing to the local development DB. Fill the ignored `.env.onboarding.production` with Render's **external** DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME. Never paste credentials into chat. Restrict Render external DB access to your current IP. Optional `DB_SSL_CA_FILE` points to a trusted PEM CA bundle if the platform's trust store is insufficient; do not disable TLS verification.
2. Remove `&& npm run db:seed` from the Render backend build. Keep `npm ci --include=dev && npm run db:generate && npm run build && npm run db:deploy`. Seeding after an exact restore can recreate users, roles/settings and publish the earlier reviewed catalog, violating parity with development. Keep automatic seeding disabled for future deploys as well.
3. Suspend/stop the backend, workers and scheduled writers; close PgAdmin/other destination clients. Do not merely close the frontend. The tool refuses replacement if other destination client connections are present. The plan can run while the service is online, but the apply command requires a maintenance window.

Run from `gami_backend` (read-only plan, no backup or data changes):

```sh
npm run db:replace-production
```

The tool is independent of Render's paid Shell. It runs from your computer. The source is restricted to loopback, the destination to a separate remote connection file. Credentials are passed privately to PostgreSQL child processes through environment variables, never command arguments or console output. Remote TLS certificate/hostname verification is mandatory.

Only after reviewing the plan, replace the two placeholders below with the exact non-secret destination identifiers from it and explicitly apply:

```sh
npm run db:replace-production -- --apply --confirm-host YOUR_EXTERNAL_RENDER_HOST --confirm-database YOUR_RENDER_DATABASE_NAME --maintenance-confirmed --seed-disabled
```

Use `--pg-bin "C:\path\to\PostgreSQL\bin"` for another client installation. Alternative private environment files can be specified with `--source-env` and `--target-env`. This command must never be added to a deployment build or cron job.

### Backup, Verification And Recovery

Each run writes to a new ignored `.db-backups/<timestamp-uuid>/` directory. The backup, generated SQL, fingerprints and private diagnostic log contain sensitive data. Restrict Windows folder permissions to the operator, use an encrypted disk, keep a protected off-machine backup, and never expose these files in static hosting or Git. Ignore rules are not encryption.

Before touching the destination, the tool exports a transaction-consistent production backup (`production-before.dump`), checks and decodes it (`production-before.sql`), records verification SQL and SHA-256 hashes, and exports a consistent sanitized development snapshot. It verifies row counts AND content fingerprints for every application table, not only users. It compares source contents from the same exported snapshot used by `pg_dump`.

Replacement drops/recreates the destination `public` schema inside one `psql --single-transaction --set=ON_ERROR_STOP=on` operation, executes the dump and checks every table before COMMIT. A SQL/constraint/content verification error rolls the entire replacement back. Earlier backups remain. A connection loss near COMMIT can leave commit status uncertain: inspect the destination against the manifest before retrying; do not assume rollback merely from a disconnected client.

After success, restart the backend without running `db:seed`, sign in with a development account and inspect its roles/memberships and the public catalog states. Store passwords/hashes in the DB, not in frontend code. Existing production and development sessions will not authorize against the copied database because the session table is empty. Recovery codes must be issued again as needed.

For an intentional recovery after a successful replacement, use the retained `production-before.dump` (or decoded SQL) and `verify-production-before.sql` under the same maintenance/TLS/transaction controls. This restores the old production state, including its old session data; revoke sessions/recovery codes explicitly if performing that later recovery. The test suite verifies native backup restoration as well as automatic failure rollback.

Focused tests: `npm test -- prisma/replace-production-db.spec.ts`. Set `RUN_DATABASE_COPY_INTEGRATION=1` to additionally create two uniquely named temporary LOCAL databases, test native dump/restore, hashes, relations, private data, identity sequences, session exclusion and verification failure rollback, then drop only those test databases. The integration test requires local CREATEDB privileges and does not touch production.
