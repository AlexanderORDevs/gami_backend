<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

Marketplace data onboarding: see [prisma/ONBOARDING.md](prisma/ONBOARDING.md) for validated Excel imports, local results, pending information, and the protected production import command.

For a full copy of development users, password hashes, roles and all application tables to production, use the explicit [database replacement procedure](prisma/README.md#full-development-to-production-replacement). It requires a prior production backup, maintenance, a private external DB connection and disabling automatic `db:seed` in Render. This is not part of the build and is not an automatic synchronization. Sessions and recovery codes are excluded by the owner's decision.

Render catalog deployment without Excel files: `npm run db:seed` loads `prisma/data/catalog-v2.json`, including store legal names and product provenance. Configure the private `CATALOG_STORE_CONTACTS_JSON` environment variable before the first deployment, as described in [Automatic Catalog Deployment](prisma/ONBOARDING.md#automatic-catalog-deployment-without-excel). Existing values, inventory, administrator accounts and settings are preserved; v2 fills only missing legal names and provenance fields. The owner-approved release now activates the three eligible stores and publishes the exact reviewed batch of 26 products once, with audit history. Subsequent deploys do not undo suspensions or withdrawals. Reference-image and unconfirmed-stock labels remain; no purchasing workflow is enabled.

```bash
$ npm install
```

## Compile and run the project

### Public Cart And Pending-Payment Checkout

Public catalog lists prioritize products with confirmed positive net availability before applying LIMIT/OFFSET. The PostgreSQL availability query uses the same visibility/search/category/store scope as the public Prisma projection, subtracts FIRM and unexpired LIVE holds, excludes inactive variants, and requires known inventory for all active variants. Secondary ordering (newest or unit price) remains stable by ID within each stock group. Hydration fetches only ranked page IDs and restores that rank, preventing available products from being stranded on later pages. Counts and safe public fields remain unchanged; no schema migration or stock mutation is needed. Optional local rollback verification: `RUN_CATALOG_STOCK_INTEGRATION=1` with `src/catalog/catalog.service.spec.ts` covers two pages, all sort modes, tariff-independent stock reservations and visibility filters.

The storefront supports an account-owned variant cart, quantities and authenticated customer checkout. This is improvement 1 only: it records a real `PENDING_PAYMENT` order, not a payment or delivery confirmation. Visitors can browse but must register/sign in as a customer before saving favorites, keeping a cart or creating an order. Staff accounts stay in the internal portal. Checkout does not accept a customer-supplied customer/store identity, unit price, final total or shipping fee.

- `GET /api/checkout/destinations`: currently effective PEN shipping destinations.
- `POST /api/checkout/quote`: validates published products, active stores, known available variant inventory and a unique effective tariff matching zone/district/unit-count. Exact district tariffs take precedence over zone-wide tariffs. Missing/ambiguous rates block checkout, not free shipping.
- `POST /api/checkout/orders`: requires JWT, a current CUSTOMER-only account with an active Customer profile, full contact/recipient/address input, UUID requestId and expected amounts from the quote. The server derives customerId from the session, checks the persisted cart, recalculates both amounts, freezes unit-price snapshots, creates one StoreOrder per store, writes an audit and LIVE stock holds, and clears that customer's cart atomically. Quantities do not decrement physical stock until the later fulfillment/payment workflow.

The same user/requestId and payload replay the same receipt, even after the cart was cleared; changing a reused payload fails. Idempotency is scoped by user so another customer cannot retrieve the receipt. Only a payload hash and safe receipt are stored in the checkout IntegrationEvent. Personal delivery data stays in Customer/Address. Customer cart locks, store advisory locks (shared with inventory operations), sorted inventory row locks and fresh stock checks serialize competing purchases. LIVE holds expire according to stock_hold_ttl_minutes (15-minute fallback) and expired LIVE holds no longer reduce available inventory; FIRM holds do not expire. This change does not add a cleanup worker or payment integration.

Public routes have an in-process Nest throttler: 30 requests/minute per IP, 8/minute for order creation. Multi-instance/shared rate limiting, bot protection and trusted proxy configuration should be reviewed before expanding public sales traffic. Rate limiting is not authentication.

### Order Detail, Store Confirmation And Incidents

Migration `20261109220000_add_order_confirmation_details` is additive and is applied by the existing Render `db:deploy` build: ordered-item confirmation quantities, an inventory recount flag, and administrative incident review notes. It does not backfill orders, change totals, or require Shell/one-off jobs. Deploy the backend before the frontend. Implementation and migration were validated only against loopback/local PostgreSQL; production was not modified.

- `GET /api/order-management/orders/:orderNumber`: owner-scoped customer detail, assigned-store-only order portions, or full detail for `SUPER_ADMIN`. Store projections omit customer/address and other stores' items and amounts; customer projections omit internal review notes.
- `POST /api/order-management/store-orders/:storeOrderId/confirm`: writable store roles only; every item requires an integer confirmed quantity. Requires a captured payment matching the frozen order total/currency and complete firm stock holds. Accepted units decrement inventory once and are ledgered; remaining reservations are released. Partial and zero confirmations create an out-of-stock incident and mark affected inventory `needs_review` until a physical recount is recorded. Prices, line totals, order total, and payment amount remain frozen. An all-zero decision does not cancel the order or issue a refund.
- `POST /api/order-management/store-orders/:storeOrderId/incidents`: writable store roles can report a typed incident against their own items. UUID request keys make safe retries idempotent. Out-of-stock incidents block affected variants from public availability, cart, checkout and store order selectors until a recount clears the flag.
- `PATCH /api/order-management/incidents/:incidentId/review`: `SUPER_ADMIN` records an internal note and review timestamp only. The incident remains open; this endpoint does not resolve it, refund money, contact a courier, or change payment state.

Customer `Mis órdenes`, store `Atención y órdenes`, and admin `/portal#orders` open the shared detail and timeline. Store confirmation stays blocked while payment is pending or unverified. Payment verification/capture, cancellation, refunds, delivery transitions and courier actions are deliberately outside this improvement. Tests: `npm test -- src/orders/order-management.service.spec.ts`; set `RUN_ORDER_MANAGEMENT_INTEGRATION=1` for local HTTP/PostgreSQL rollback checks and disposable-database concurrency tests. Catalog stock ordering and checkout/store-operation regressions also cover the recount flag.

### Manual Payout Drafts

`POST /api/admin/information/payouts` is available only through the existing `SUPER_ADMIN`, JWT and password-change guards. It records a PEN amount, recipient store, optional scheduled date and required audit reason as `DRAFT`. The request UUID is scoped to the administrator and idempotent; reusing it with different input conflicts. This endpoint does not mark a transfer as paid, allocate pending settlements, create a ledger entry, calculate a balance, or move funds.

The payout table has an `is_demo` marker. The deployment seed creates one idempotent example for DMarco: `S/ 1.00`, status `DRAFT`, marked `DEMO` in the UI and audited as not transferred. It is created once by the normal `db:seed` step on backend deploy; no direct production database write is performed. Existing payouts are not modified. Tests: `npm test -- src/admin-information/admin-information.service.spec.ts prisma/deployment-catalog.spec.ts`; set `RUN_PAYOUT_INTEGRATION=1` for the local rollback test.

Migration `20261109223000_add_payout_demo_flag` adds `payouts.is_demo` with default `false`, preserving existing rows. The next backend deployment applies it through `db:deploy`, then the standard `db:seed` inserts the marked example if its fixed ID is absent.

The internal order form remains store-scoped and now calculates its shipping cost from the configured tariff; neither staff nor the client can type a replacement amount. Public checkout uses the same contact/address validation contract and server-side tariff resolver. It never allows products with unknown stock, unpublished products, suspended stores or stale prices. Account persistence requires the migration below, not a seed or database replacement. No invented tariffs, holidays, payment credentials or courier calls are added. An empty shipping_rates table intentionally prevents order confirmation until real tariffs are configured (improvement 4).

### Shipping Rates And Logistics Calendar

`POST /api/admin/information/shipping-rates` lets `SUPER_ADMIN` register a PEN tariff with zone, optional district, inclusive item-count range and validity interval. Overlapping active rules for the same zone/district, quantity and dates are rejected. `POST /api/admin/information/calendar` creates or updates one working/non-working calendar date. Both require an audit reason; no assumed prices, weekends or holidays are seeded.

Public checkout and store-created orders share the same effective-rate resolver: an exact district rate takes precedence over a zone-wide rate; exactly one applicable rule must remain. The internal order form requests a quote from the existing checkout endpoint and displays the calculated shipping/total; the create-order API accepts expected subtotal/shipping only for stale-quote detection, recalculates both server-side, and rejects mismatches. It no longer accepts a manually entered shipping amount. With no applicable configured rate, the form cannot create the order.

Calendar entries can now be administered, but no delivery date or SLA is derived from them yet; a logistics owner and scheduling policy are still needed before the calendar changes fulfillment promises.

Verification: `npm test -- src/catalog/checkout.service.spec.ts`. Set `RUN_CHECKOUT_INTEGRATION=1` for local-only HTTP/PostgreSQL rollback tests and a disposable-schema concurrency test (PostgreSQL 18 tools/CREATEDB required). All temporary databases are removed on completion. The frontend is tested with isolated mocked checkout responses; never use real customer data for UI tests.

### Customer Accounts And Render Deployment

`20261109183000_add_customer_accounts` is additive: it inserts the CUSTOMER role if missing and creates customer_cart_items/customer_favorites with ownership foreign keys and composite primary keys. It does not change existing users, passwords, store memberships, inventory or orders. Existing guest Customer rows remain unlinked; no matching by email/phone or automatic transfer of old orders or browser-local guest favorites is performed.

Keep `npm run db:deploy` in the Render backend build, after client generation/build. Pushing and deploying backend applies the migration automatically, including on plans without Shell or one-off jobs. Deploy the frontend as well. This feature does not need `db:seed`, a SQL dump, production shell access, a reset or a direct database connection. Local validation was restricted to loopback; no production writes were performed by the implementation.

Public routes: `POST /api/customers/register` accepts only username/displayName/email/phone/password and creates exactly CUSTOMER plus a linked profile; roles/status/storeId inputs are rejected. Registration has a five-per-minute limit and login ten-per-minute. Passwords require at least 12 characters and at most 72 UTF-8 bytes for bcrypt; case-insensitive existing identities cannot be registered again. The database role comes from the migration, never public input. `POST /api/customers/login` reuses normal sessions; staff accounts are rejected and the resulting staff-login session is revoked.

Private routes derive the owner from JWT plus a fresh Customer/User/roles check. CUSTOMER combined with staff roles or an active store membership cannot use these routes:

Public customer registration requires phone to match `^9\d{8}$`: exactly nine Peruvian mobile digits without +51. This is enforced by RegisterCustomerDto, not just the input mask. Existing stored profile phones and the profile-update contract are unchanged. Registration has no password-confirmation field in its contract; the UI suggestion meets the existing 12-character minimum and bcrypt size limit.

- `GET/PATCH /api/customers/me`: read profile; update displayName and phone only (email/identity/roles are not writable here).
- `GET /api/customers/me/cart`, `PUT/DELETE /api/customers/me/cart/:variantId`: current-price/stock projections and persisted quantities, max 50 variants. Cart changes serialize per customer and adding stock does not reserve it.
- `GET /api/customers/me/favorites`, `PUT/DELETE /api/customers/me/favorites/:productId`: max 100 distinct saved products, idempotent writes.
- `GET /api/customers/me/orders?page=1`: safe own-order summary/items, 20 per page, no cross-customer lookup.

Profile changes and registration are audited. Public registration has no role grant, store assignment or staff reset capability. Customer UI reuses change-password/email-recovery endpoints and keeps its session separate from the staff portal; email recovery still requires configured SMTP, and no mail provider or verification service is fabricated. Tokens follow the existing sessionStorage/refresh-rotation pattern; move refresh tokens to the documented HttpOnly cookie boundary before broad production rollout. Payment integration, email verification, bot protection and distributed rate limiting remain separate work.

Tests: `npm test -- src/customers`. Set `RUN_CUSTOMERS_INTEGRATION=1` for real local JWT/HTTP registration, duplicate/privilege rejection, cart/favorite isolation, own history, checkout ownership, staff rejection and revoked-session checks; every fixture rolls back. Checkout integration also tests two different customers competing for the last stock unit.

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observer](https://observer.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
