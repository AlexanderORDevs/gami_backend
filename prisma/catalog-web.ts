import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import {
  cents,
  normalized,
  stableId,
  type WorkbookSheet,
} from './onboarding-workbook.js';
import {
  legacyReferenceImage,
  referenceImageFor,
} from './onboarding-images.js';

export type WebProduct = {
  sourceId: string;
  row: number;
  active: boolean;
  brand: string;
  name: string;
  category: string;
  price: number;
  description: string | null;
  images: string[];
  attributes: Prisma.InputJsonObject;
};

export function imageUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'res.cloudinary.com' ||
    !url.pathname.startsWith('/djmtejkw7/image/upload/') ||
    url.username ||
    url.password ||
    url.port ||
    value.length > 180
  ) {
    throw new Error(
      'Unexpected image URL; only the workbook Cloudinary account is allowed.',
    );
  }
  return url.href;
}

export function planWebCatalog(sheets: WorkbookSheet[]) {
  const sheet = sheets.find((item) => item.name === 'Catálogo Web');
  if (!sheet) throw new Error('Missing Catálogo Web sheet.');
  const header = sheet.rows.find(
    (row) => row.cells.A === 'id' && row.cells.Q === 'img_portada_url',
  );
  if (
    !header ||
    header.cells.R !== 'imgs_galeria_urls' ||
    header.cells.E !== 'nombre' ||
    header.cells.I !== 'precio_venta_S/'
  ) {
    throw new Error('Unrecognized web catalog headers.');
  }
  const products: WebProduct[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const row of sheet.rows.filter((item) => item.number > header.number)) {
    const cells = row.cells;
    if (cells.A === 'N.º único') continue;
    if (!cells.E || !cells.D) {
      warnings.push(
        `Row ${row.number}: incomplete product retained in archive.`,
      );
      continue;
    }
    if (!/^\d+$/.test(cells.A ?? '') || ids.has(cells.A))
      throw new Error(`Row ${row.number}: invalid or duplicate source ID.`);
    ids.add(cells.A);
    if (!['si', 'no'].includes(normalized(cells.B ?? '')))
      throw new Error(`Row ${row.number}: invalid active flag.`);
    if (!['marca_aliada', 'hallazgo_gami'].includes(cells.C ?? ''))
      throw new Error(`Row ${row.number}: invalid product origin.`);
    if (
      cells.E.length > 180 ||
      cells.D.length > 120 ||
      !cells.F ||
      cells.F.length > 80
    )
      throw new Error(`Row ${row.number}: invalid product fields.`);
    const sizes = (cells.N ?? '')
      .split('/')
      .map((value) => value.trim())
      .filter(Boolean);
    const colors = (cells.O ?? '')
      .split('/')
      .map((value) => value.trim())
      .filter(Boolean);
    const hex = (cells.P ?? '').split('/').map((value) => value.trim());
    if (
      colors.length !== hex.length ||
      hex.some((value) => !/^#[\da-f]{6}$/i.test(value))
    ) {
      warnings.push(
        `Row ${row.number}: incomplete color palette; original values retained.`,
      );
    }
    const images = [
      ...new Set(
        [cells.Q, ...(cells.R ?? '').split('|')]
          .filter(Boolean)
          .map((value) => imageUrl(value.trim())),
      ),
    ];
    products.push({
      sourceId: cells.A,
      row: row.number,
      active: normalized(cells.B) === 'si',
      brand: cells.D,
      name: cells.E,
      category: cells.F,
      price: cents(cells.I ?? '', `Row ${row.number}`),
      description: cells.S ?? null,
      images,
      attributes: {
        catalog_web_id: cells.A,
        catalog_web_type: cells.C,
        declared_sizes: sizes,
        declared_colors: colors.map((name, index) => ({
          name,
          hex: /^#[\da-f]{6}$/i.test(hex[index] ?? '') ? hex[index] : null,
        })),
        ...(cells.G ? { occasion: cells.G } : {}),
        ...(cells.H ? { other_occasions: cells.H } : {}),
      },
    });
  }
  return { products, warnings };
}

async function checkImages(products: WebProduct[]) {
  const urls = [...new Set(products.flatMap((product) => product.images))];
  const valid = new Set<string>();
  const failed: string[] = [];
  for (let offset = 0; offset < urls.length; offset += 6) {
    await Promise.all(
      urls.slice(offset, offset + 6).map(async (url) => {
        try {
          const response = await fetch(url, {
            method: 'HEAD',
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });
          if (
            !response.ok ||
            !response.headers.get('content-type')?.startsWith('image/')
          )
            throw new Error('Not an accessible image.');
          valid.add(url);
        } catch {
          failed.push(url);
        }
      }),
    );
  }
  return { valid, failed };
}

export async function importWebCatalog(
  sheets: WorkbookSheet[],
  environment: Record<string, string>,
  apply: boolean,
  target: string,
): Promise<void> {
  const plan = planWebCatalog(sheets);
  const checked = await checkImages(plan.products);
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        source: 'catalog-web',
        products: plan.products.length,
        active: plan.products.filter((product) => product.active).length,
        verifiedImages: checked.valid.size,
        failedImages: checked.failed,
        warnings: plan.warnings,
      },
      null,
      2,
    ),
  );
  if (
    !checked.valid.size &&
    plan.products.some((product) => product.images.length)
  ) {
    throw new Error(
      'No images could be verified. Check connectivity and trusted certificates; no import performed.',
    );
  }
  const connectionString = `postgresql://${encodeURIComponent(environment.DB_USER)}:${encodeURIComponent(environment.DB_PASSWORD)}@${environment.DB_HOST}:${environment.DB_PORT}/${encodeURIComponent(environment.DB_NAME)}`;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      ssl: target === 'production' ? { rejectUnauthorized: true } : undefined,
    }),
  });
  try {
    const result = await prisma.$transaction(
      async (transaction) => {
        if (apply)
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(728401928)`;
        const stores = await transaction.store.findMany({
          where: { deletedAt: null },
          select: { id: true, displayName: true },
        });
        const report = {
          created: 0,
          matched: 0,
          imageLinksAdded: 0,
          referencesReplaced: 0,
          pending: [] as {
            sourceId: string;
            name: string;
            brand: string;
            reason: string;
          }[],
          products: [] as {
            id: string;
            sourceId: string;
            name: string;
            images: number;
            action: string;
          }[],
          warnings: [...plan.warnings],
          failedImages: checked.failed,
        };
        for (const product of plan.products) {
          const matches = stores.filter(
            (store) =>
              normalized(store.displayName) === normalized(product.brand),
          );
          if (matches.length !== 1) {
            report.pending.push({
              sourceId: product.sourceId,
              name: product.name,
              brand: product.brand,
              reason:
                'Store identity/contact onboarding is missing or ambiguous.',
            });
            continue;
          }
          const store = matches[0];
          const sourceProductId = stableId(
            `catalog-web:product:${product.sourceId}`,
          );
          const candidates = await transaction.product.findMany({
            where: {
              OR: [
                { id: sourceProductId },
                {
                  storeId: store.id,
                  name: { equals: product.name, mode: 'insensitive' },
                },
              ],
            },
          });
          if (candidates.length > 1)
            throw new Error(
              `Web product ${product.sourceId}: ambiguous existing product.`,
            );
          const existing = candidates[0];
          if (existing && (existing.deletedAt || existing.storeId !== store.id))
            throw new Error(
              `Web product ${product.sourceId}: identity conflict.`,
            );
          if (
            existing &&
            !['DRAFT', 'UNDER_REVIEW', 'CHANGES_REQUESTED'].includes(
              existing.status,
            )
          ) {
            report.pending.push({
              sourceId: product.sourceId,
              name: product.name,
              brand: product.brand,
              reason: 'Operational/approved product requires manual review.',
            });
            continue;
          }
          const id = existing?.id ?? sourceProductId;
          const images = product.images.filter((url) => checked.valid.has(url));
          report.products.push({
            id,
            sourceId: product.sourceId,
            name: product.name,
            images: images.length,
            action: existing ? 'enrich' : 'create',
          });
          if (!apply) continue;
          if (!existing) {
            await transaction.product.create({
              data: {
                id,
                storeId: store.id,
                name: product.name,
                description: product.description,
                category: product.category,
                garmentType: product.category,
                unitPriceInCents: product.price,
                attributes: product.attributes,
                status: product.active ? 'UNDER_REVIEW' : 'DRAFT',
              },
            });
            report.created++;
          } else {
            const attributes =
              existing.attributes &&
              typeof existing.attributes === 'object' &&
              !Array.isArray(existing.attributes)
                ? existing.attributes
                : {};
            await transaction.product.update({
              where: { id },
              data: {
                attributes: { ...product.attributes, ...attributes },
                ...(!existing.description && product.description
                  ? { description: product.description }
                  : {}),
              },
            });
            report.matched++;
            if (existing.unitPriceInCents !== product.price)
              report.warnings.push(
                `Web product ${product.sourceId}: existing price retained; source price archived.`,
              );
          }
          if (!images.length) continue;
          const current = await transaction.productAttribute.findMany({
            where: { productId: id, code: 'image_url' },
            orderBy: { position: 'asc' },
          });
          const reference = await transaction.productAttribute.findFirst({
            where: {
              productId: id,
              code: 'image_kind',
              value: 'reference_only_not_actual_product',
            },
          });
          const replaceReference =
            Boolean(reference) &&
            current.every((image) =>
              [legacyReferenceImage, referenceImageFor(id)].includes(
                image.value,
              ),
            );
          if (replaceReference) {
            await transaction.productAttribute.deleteMany({
              where: {
                productId: id,
                code: { in: ['image_url', 'image_kind'] },
              },
            });
            report.referencesReplaced++;
          }
          const keep = replaceReference ? [] : current;
          let position = keep.length
            ? Math.max(...keep.map((image) => image.position)) + 1
            : 0;
          for (const url of images) {
            if (keep.some((image) => image.value === url)) continue;
            await transaction.productAttribute.create({
              data: {
                productId: id,
                code: 'image_url',
                value: url,
                position: position++,
              },
            });
            report.imageLinksAdded++;
          }
        }
        if (apply) {
          const contentHash = createHash('sha256')
            .update(JSON.stringify({ source: 'catalog-web-v1', sheets }))
            .digest('hex');
          const batch = await transaction.onboardingBatch.upsert({
            where: { contentHash },
            update: { report },
            create: {
              contentHash,
              source: 'GAMI Web Catalog',
              snapshot: sheets,
              report,
            },
          });
          if (
            report.created ||
            report.imageLinksAdded ||
            report.referencesReplaced
          )
            await transaction.auditLog.create({
              data: {
                entityType: 'onboarding_batch',
                entityId: batch.id,
                action: 'WEB_CATALOG_IMPORTED',
                channel: 'SYSTEM',
                reason: 'Complementary catalog images and product descriptions',
                metadata: {
                  created: report.created,
                  imageLinksAdded: report.imageLinksAdded,
                  referencesReplaced: report.referencesReplaced,
                },
              },
            });
        }
        return report;
      },
      { timeout: 120000, isolationLevel: 'Serializable' },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
