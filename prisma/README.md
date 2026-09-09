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

The seed is idempotent. Initial administrator credentials come from local environment variables and must be changed before any shared or production deployment.
