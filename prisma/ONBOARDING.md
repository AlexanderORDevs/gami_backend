# Marketplace onboarding import

Run commands from `gami_backend`. Requires Node.js 22, the development dependencies (`npm ci --include=dev`), and the generated Prisma client (`npm run db:generate`). The Excel stays outside Git; it contains personal and bank information. Never deploy it into frontend/public or commit it as seed data.

## Local import

```sh
npm run db:onboarding -- --file "../GAMI — Onboarding Marketplace.xlsx"
npm run db:onboarding -- --file "../GAMI — Onboarding Marketplace.xlsx" --apply --migrate
```

Without `--apply`, the command only validates the workbook and prints a plan. It does not connect to the database or run migrations. `--migrate` explicitly runs pending Prisma migrations before the import. If importing fails, data writes roll back together; already-applied schema migrations remain.

The default environment file is `.env`. Local mode accepts only localhost/loopback DB hosts. It never falls back to a remote environment. Existing data is not reset.

## Production from your computer

### Local storefront preview

To inspect imported products in the customer storefront without approving them for sale, set `CATALOG_LOCAL_PREVIEW=true` in the backend's local `.env` and restart the backend. The frontend remains at `http://localhost:3000` with its API at `http://localhost:4000/api`.

Preview is enabled only when `NODE_ENV=development`, `DB_HOST` is localhost/loopback, and `RENDER` is not `true`. It includes `UNDER_REVIEW` products from onboarding stores as well as the usual published catalog. Suspended, rejected, deleted and draft records remain hidden. Lists, details, category filters and brands share the same visibility rules; brands still need at least three visible products.

This is a developer-only preview, not a public review link. Original onboarding images remain referential; the complementary web catalog can supply actual product photos. No database statuses or approval evidence are changed. Set the flag to `false` and restart to return to the normal public view. Do not enable this flag in Render; production continues to require `PUBLISHED` products and `ACTIVE` stores.

### Production Import

Deploy the backend commit first, including the new `onboarding_batches` migration. Keep the normal Render build command; do not add this private workbook to the build or run the general admin seed again:

```sh
npm ci --include=dev && npm run db:generate && npm run build && npm run db:deploy
```

Complete the ignored `.env.onboarding.production` file on your computer with the Render database's **external** hostname and real database credentials. Do not use the internal Render hostname from your computer. Do not reuse development credentials. Keep only DB settings in this file; the import does not need JWT, SMTP, or INITIAL_ADMIN settings.

```dotenv
DB_HOST=YOUR_EXTERNAL_RENDER_POSTGRES_HOST
DB_PORT=5432
DB_USER=YOUR_RENDER_DATABASE_USER
DB_PASSWORD=YOUR_RENDER_DATABASE_PASSWORD
DB_NAME=YOUR_RENDER_DATABASE_NAME
```

Allow your current public IP in Render's database external access rules if needed. Production import uses TLS with certificate verification. Never disable certificate verification to bypass an error. A Render interactive shell or paid backup import is not needed for this workflow.

Validate first, then replace `YOUR_RENDER_DATABASE_NAME` below with the exact DB_NAME and apply:

```sh
npm run db:onboarding -- --file "../GAMI — Onboarding Marketplace.xlsx" --env-file .env.onboarding.production --target production
npm run db:onboarding -- --file "../GAMI — Onboarding Marketplace.xlsx" --env-file .env.onboarding.production --target production --confirm-database YOUR_RENDER_DATABASE_NAME --apply
```

No production import has been run as part of the initial local implementation. Only the owner should supply production credentials directly in the ignored environment file, never in chat or logs.

## Mapping and safety

- Original product responses are authoritative for variants. `Variantes_Normalizadas` has shifted headers and omits variants present in the original responses. `Productos_Normalizados` supplies stable product UUIDs; new products without an ID receive a deterministic identity.
- Store matching ignores case, accents and punctuation, so `DMarco` and `D'MARCO` resolve together. Ambiguous identities fail rather than merge accounts or stores silently. Product UUIDs and SKU identities must remain stable on future exports.
- Amounts are integer PEN cents. Only explicit nonnegative integer quantities are imported. Incomplete variant lines are reported and retained, never expanded into invented size/color combinations.
- Excel date cells are interpreted as Lima wall time (UTC-05:00). If stock count time is absent, the original submission time is used and the product records `stock_date_source=submission`. Importing does not make old stock appear freshly counted.
- Only explicitly supplied opening/closing pairs become store hours. An affirmative open-day answer without hours remains pending. Incomplete schedules must not be treated as complete operating calendars.
- Store accounts receive only `STORE_OPERATOR`, even when the sheet calls the contact an administrator. `Propietario/a` maps to membership ownership, not global administration. Missing user email or unrecognized roles remain pending. Store contact email is never silently substituted for a login email.
- New users receive an undisclosed, cryptographically random password hash and `mustChangePassword=true`. A platform administrator must issue a temporary password through the existing user-management workflow. No reusable plaintext passwords are exported, logged, or committed. Existing accounts/passwords/permissions are not changed; duplicate contacts require manual reconciliation.
- New stores are `APPLIED`, products `UNDER_REVIEW`. Neither is automatically activated/published, and WhatsApp is not marked verified. This is an administrative import, not approval to sell. Seller workspaces and activation/publication workflows are not implemented by this command.
- The six imported models receive distinct HTTPS reference photos and `image_kind=reference_only_not_actual_product`. The storefront labels these as references, not actual product photography. New unknown models retain the generic fallback. Replace these images before publication. Existing product photos are preserved; source Drive/document links are retained privately, not mistaken for public image assets.
- Every populated row and all headers from all seven sheets are preserved in `onboarding_batches.snapshot`. This includes RUC, contacts, bank account/CCI, document/image links, pickup details, closures and observations with no current operational field. This is private intake data, not validated payout configuration. There is no public endpoint for this table. Restrict database access and include it in protected backup/retention policies.
- Each content hash is applied once. A repeat returns `alreadyImported: true`; it can replace the old tagged generic reference image on the six known draft/review models with distinct references, reporting `referenceImagesUpdated` and auditing that change. It does not replace actual images or approved products, and repeating the image refresh makes no further changes. Later changed files can add records and update imported draft/review store/product details, but do not remove rows, reset inventory, replace passwords, grant extra access to existing users, or overwrite operational/approved entities. Changed inventory and conflicting hours are retained in the new private snapshot and reported for manual reconciliation.
- Concurrent imports are serialized with a PostgreSQL advisory lock and a serializable transaction. A batch audit event contains counts and the source hash, not personal/bank data.

## Initial local result (2026-09-28)

| Entity                             | Imported |
| ---------------------------------- | -------: |
| Stores                             |        3 |
| Products                           |        6 |
| Variants / initial stock movements |       74 |
| Declared units                     |      821 |
| Opening intervals                  |       10 |
| Store accounts / memberships       |        2 |
| Archived sheets                    |        7 |

Stores: Heinz Club, DMarco, Akm Store. The six products belong to DMarco and Akm Store. Four historical `Errores_Carga` entries for trouser colors are resolved by reading the original responses, recovering 20 variants missing from the normalized sheet.

Pending: SOHAS only has a catalog name; the DMarco user has no explicit login email; Tuesday through Saturday hours are missing for Heinz Club and DMarco; the jacket has no stock-count timestamp; real product images and approval evidence are incomplete. These omissions are not filled with assumptions.

The local import was repeated successfully without duplication. Integration verification found 74 inventories, 74 initial movements, 821 total units, two memberships, and one batch containing seven sheets.

## Coverage Audit

Rechecked against the current workbook on 2026-09-28. Counts exclude header rows; duplicate normalized sheets are not additional products.

| Sheet                  | Rows | Usage                                                                                                                                          |
| ---------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Form Responses 1       |    3 | Three store registrations, ten complete opening intervals, two eligible store accounts. All remaining fields retained in the private snapshot. |
| Form Responses 2       |    6 | Six authoritative product declarations including variants, stock, descriptions, prices and wholesale minimums.                                 |
| Productos_Normalizados |    6 | The same six products, supplying stable source IDs. Not six additional products.                                                               |
| Variantes_Normalizadas |   54 | Retained for traceability; shifted headers and incomplete normalization mean original responses supply the operational variants.               |
| Errores_Carga          |    4 | Historical normalization errors retained. Original trouser responses recover 20 omitted size/color variants.                                   |
| Tiendas_Catalogo       |    5 | Names checked against onboarding. DMarco and D'MARCO are one store; SOHAS has no full store registration.                                      |
| README                 |    5 | Workbook metadata retained, not operational application records.                                                                               |

| Store            | Models | Variants | Declared units | Accounts | Opening intervals |
| ---------------- | -----: | -------: | -------------: | -------: | ----------------: |
| DMarco / D'MARCO |      3 |       59 |            640 |        0 |                 2 |
| Akm Store        |      3 |       15 |            181 |        1 |                 7 |
| Heinz Club       |      0 |        0 |              0 |        1 |                 1 |
| SOHAS            |      0 |        0 |              0 |        0 |                 0 |

SOHAS is archived as a name only, not a created Store. Heinz Club exists in the administrative database, but does not appear in the storefront brand directory because it has no products. The directory requires at least three visible products.

### Operational Data

- Stores: commercial/legal names when supplied, gallery, stand, WhatsApp and complete declared opening intervals.
- Products: name, description, customer category, garment type, unit/wholesale prices and minimum quantity. Material, fit, finish and care are stored in Product.attributes. The public detail now renders the allowlisted material, fit, details and care fields, never the raw attributes JSON.
- Variants: source size labels, normalized sizes, colors and explicit stock; 74 inventories and initial movements. Source SKUs are used when explicitly supplied in the original declaration; otherwise deterministic GAMI SKUs are generated. The generated SKUs in the normalized sheet are preserved in the source snapshot, not adopted as a second variant identity.
- Access: two accounts with STORE_OPERATOR and their own store membership, one ownership flag. No global administrator rights or usable plaintext passwords are imported. An administrator must issue temporary credentials.

### Archived, Not Operationally Integrated

Bank name, account holder/number, CCI, currency, RUC and tax/document links, receipt capabilities, pickup reference/instructions, general contacts, free-text closures/holiday answers, access requests lacking complete identity, observations, source image/gallery links and source metadata remain in the private JSON snapshot. They have not been converted into payout settings, tax validation, downloaded documents, actual product image galleries, dated closures or new UI workflows. Missing fields remain missing. XLSX styling and embedded binaries are not imported; the archive contains cell values and headers.

### Pending Information

- SOHAS: complete store/contact registration and product declarations.
- Heinz Club: product declarations; Tuesday-Saturday opening/closing times.
- DMarco: explicit user login email and Tuesday-Saturday hours. The store contact email is not substituted for the missing access email.
- Jacket: stock-count timestamp missing; original submission timestamp used and marked accordingly.
- All products: verified product photography; generic reference photos are only for layout review. Existing Drive links remain archived until access and actual image assets can be validated.
- Store activation/product publication and operational validation remain separate from importing the workbook. No production database changes were made during this UI review.

## Complementary Web Catalog

The sections above describe the first workbook. `gami_catalogo_web.xlsx` is a separate catalog, not a replacement for store onboarding. Run the original onboarding and schema migration first. Use Node.js 22.19+; this command enables `--use-system-ca` to validate Cloudinary TLS with the machine's trusted certificate store, without disabling verification.

```sh
npm run db:catalog-web -- --file ../gami_catalogo_web.xlsx
npm run db:catalog-web -- --file ../gami_catalogo_web.xlsx --apply
```

This dry run validates image URLs and **connects read-only to the selected database** to check exact product/store matches. Unlike the original workbook dry run, it requires database connectivity. `--migrate` is not supported for this source; deploy migrations separately.

For production, reuse the separate ignored credentials file and exact database confirmation, after reviewing local results:

```sh
npm run db:catalog-web -- --file ../gami_catalogo_web.xlsx --env-file .env.onboarding.production --target production
npm run db:catalog-web -- --file ../gami_catalogo_web.xlsx --env-file .env.onboarding.production --target production --confirm-database YOUR_RENDER_DATABASE_NAME --apply
```

- Identity is the stable numeric source ID, or an exact product name within an unambiguous normalized store. There is no fuzzy product matching. Do not renumber IDs across exports.
- The owner confirmed that the three new D'MARCO models are different from the three original DMarco models, and that `gami` tops are not the original Akm products. No photos are transferred between these identities.
- Only verified HTTPS image URLs from the workbook's Cloudinary account are accepted. Cover and gallery links are deduplicated and stored as ordered `image_url` attributes. Image binaries stay on Cloudinary; the database stores URLs, not downloaded files. Existing actual photos are preserved; only recognized tagged reference images on editable products can be replaced.
- Names, descriptions, category/garment type and retail prices are imported for new products. Sizes, color names/hex codes, type and occasions are retained in safe product attributes. Existing product prices and populated attributes are not overwritten. No quantities or size/color combinations are invented: new models show declared options and **Stock por confirmar** until real variants/inventory exist.
- New active rows become UNDER_REVIEW, inactive rows DRAFT; neither is published. Existing operational/approved products require manual reconciliation. The public API exposes galleries, declared options and allowlisted specifications, not arbitrary JSON or internal pricing.
- All three sheets (catalog, palette and instructions), internal commissions/pricing, missing-store rows and the incomplete ID 37 row are archived privately in `onboarding_batches.snapshot`. Archiving is not operational onboarding or payout setup.
- Repeating the source can resolve pending rows once their real store is registered. It does not duplicate products/photos or reset inventory. The latest batch report records pending rows; the audit records actual product/photo additions. Confirm store identity/contact details instead of inventing WhatsApp numbers.

### Verified Local Result

36 complete rows: 33 active, 3 inactive. All 115 distinct image URLs passed HTTPS/content-type checks. The instructions sheet's older missing-photo note is superseded by populated image cells.

| Brand            | New products imported | Pending | Operational image links |
| ---------------- | --------------------: | ------: | ----------------------: |
| Heinz Club       |                    17 |       0 |                      59 |
| DMarco / D'MARCO |                     3 |       0 |                       8 |
| SOHAS            |                     0 |       6 |                       0 |
| gami             |                     0 |      10 |                       0 |

Local totals are now **26 products**, 3 stores, 74 variants and **821 units**. The 20 new products have 67 actual-photo links; the original six retain their reference photos because no corresponding actual images were identified. Both source workbooks are archived as two batches. A second applied run created zero products and zero image links. SOHAS and gami need store identity/contact onboarding before their 16 archived products can be integrated. No production database has been changed.
