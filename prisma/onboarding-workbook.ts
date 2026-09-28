import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';

export type WorkbookRow = { number: number; cells: Record<string, string> };
export type WorkbookSheet = {
  name: string;
  headers: Record<string, string>;
  rows: WorkbookRow[];
};

export async function readOnboardingWorkbook(
  path: string,
): Promise<WorkbookSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook.worksheets.map((sheet) => {
    const headers: Record<string, string> = {};
    sheet.getRow(1).eachCell((cell) => {
      headers[sheet.getColumn(cell.col).letter] = String(cell.text ?? '');
    });
    const rows: WorkbookRow[] = [];
    sheet.eachRow((row, number) => {
      if (number === 1) return;
      const cells: Record<string, string> = {};
      row.eachCell((cell) => {
        const value = cell.value;
        if (
          value &&
          typeof value === 'object' &&
          'formula' in value &&
          value.result === undefined
        ) {
          throw new Error(
            `${sheet.name}!${cell.address}: formula has no cached value.`,
          );
        }
        const text =
          value instanceof Date
            ? value.toISOString()
            : value && typeof value === 'object' && 'hyperlink' in value
              ? value.hyperlink
              : String(cell.text ?? '');
        if (text.trim()) cells[sheet.getColumn(cell.col).letter] = text.trim();
      });
      if (Object.keys(cells).length) rows.push({ number, cells });
    });
    return { name: sheet.name, headers, rows };
  });
}

export function normalized(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function stableId(key: string): string {
  const digest = createHash('sha256')
    .update(`gami-onboarding:${key}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function integer(value: string, context: string, minimum = 0): number {
  if (!/^\d+$/.test(value)) throw new Error(`${context}: expected an integer.`);
  const result = Number(value);
  if (
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > 2147483647
  ) {
    throw new Error(`${context}: integer out of range.`);
  }
  return result;
}

export function cents(value: string, context: string): number {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value))
    throw new Error(`${context}: invalid price.`);
  return integer(
    String(Math.round(Number(value.replace(',', '.')) * 100)),
    context,
    1,
  );
}

function required(
  value: string | undefined,
  context: string,
  maximum: number,
): string {
  if (!value || value.length > maximum)
    throw new Error(`${context}: missing or over ${maximum} characters.`);
  return value;
}

function phone(value: string | undefined, context: string): string {
  const digits = (value ?? '').replace(/[\s()+-]/g, '');
  const international = /^9\d{8}$/.test(digits) ? `51${digits}` : digits;
  if (!/^[1-9]\d{9,14}$/.test(international))
    throw new Error(`${context}: invalid international phone.`);
  return `+${international}`;
}

function localTimestamp(value: string, context: string): Date {
  const timestamp = new Date(value.replace(/Z$/, '-05:00'));
  if (!Number.isFinite(timestamp.getTime()))
    throw new Error(`${context}: invalid Lima timestamp.`);
  return timestamp;
}

function clock(value: string): Date {
  const match = /(?:T|^)(\d{2}):(\d{2})(?::\d{2})?/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error('Invalid opening/closing time.');
  return new Date(`1970-01-01T${match[1]}:${match[2]}:00.000Z`);
}

export type PlannedUser = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  phone: string | null;
  isOwner: boolean;
};
export type PlannedStore = {
  id: string;
  key: string;
  displayName: string;
  legalName: string | null;
  gallery: string | null;
  standNumber: string | null;
  whatsappNumber: string;
  hours: { dayOfWeek: number; opensAt: Date; closesAt: Date }[];
  users: PlannedUser[];
};
export type PlannedVariant = {
  id: string;
  sku: string;
  color: string;
  sizeLabel: string;
  sizeNormalized: string;
  quantity: number;
};
export type PlannedProduct = {
  id: string;
  storeId: string;
  name: string;
  description: string | null;
  category: string;
  garmentType: string;
  unitPriceInCents: number;
  wholesalePriceInCents: number | null;
  wholesaleMinimum: number | null;
  attributes: Record<string, string>;
  stockUpdatedAt: Date;
  variants: PlannedVariant[];
};
export type OnboardingPlan = {
  stores: PlannedStore[];
  products: PlannedProduct[];
  warnings: string[];
};

export function planOnboarding(sheets: WorkbookSheet[]): OnboardingPlan {
  const warnings: string[] = [];
  function sheet(name: string, headers: Record<string, string>): WorkbookSheet {
    const found = sheets.find((item) => item.name === name);
    if (!found) throw new Error(`Missing sheet: ${name}`);
    for (const [column, title] of Object.entries(headers)) {
      if (found.headers[column] !== title)
        throw new Error(
          `${name}!${column}1: unexpected header; review workbook mapping.`,
        );
    }
    return found;
  }
  const storeSheet = sheet('Form Responses 1', {
    H: 'Nombre comercial2',
    O: 'WhatsApp principal',
    AQ: 'Usuario 1 — rol',
  });
  const productSheet = sheet('Form Responses 2', {
    K: 'Nombre / modelo del producto 2',
    X: 'Variantes y stock',
  });
  const normalizedSheet = sheet('Productos_Normalizados', {
    A: 'ID carga',
    C: 'Tienda',
    F: 'Producto / modelo',
  });
  const stores: PlannedStore[] = [];
  const dayColumns = [
    ['R', 'S', 'T', 'G', 'BG', 'BH', 'BI', 'BJ'],
    ['U', 'V', 'W', 'BK', 'BL', 'BM', 'BN', 'BO'],
    ['X', 'Y', 'Z', 'BP', 'BQ', 'BR', 'BS', 'BT'],
    ['AA', 'AB', 'AC', 'BU', 'BV', 'BW', 'BX', 'BY'],
    ['AD', 'AE', 'AF', 'BZ', 'CA', 'CB', 'CC', 'CD'],
    ['AG', 'AH', 'AI', 'CE', 'CF', 'CG', 'CH', 'CI'],
    ['AJ', 'AK', 'AL', 'CJ', 'CK', 'CL', 'CM', 'CN'],
  ];
  for (const row of storeSheet.rows) {
    const cells = row.cells;
    const context = `${storeSheet.name}!${row.number}`;
    const displayName = required(cells.H ?? cells.B, context, 120);
    const key = normalized(displayName);
    if (!key || stores.some((store) => store.key === key))
      throw new Error(`${context}: duplicate store identity.`);
    const store: PlannedStore = {
      id: stableId(`store:${key}`),
      key,
      displayName,
      legalName: cells.I ?? cells.C ?? null,
      gallery: cells.K ?? cells.D ?? null,
      standNumber: cells.L ?? cells.E ?? null,
      whatsappNumber: phone(cells.O ?? cells.F, context),
      hours: [],
      users: [],
    };
    dayColumns.forEach(
      (
        [
          attends,
          start,
          end,
          newAttends,
          firstStart,
          firstEnd,
          secondStart,
          secondEnd,
        ],
        day,
      ) => {
        const open = normalized(cells[newAttends] ?? cells[attends] ?? '');
        if (open !== 'si') return;
        const intervals =
          cells[firstStart] || cells[firstEnd]
            ? [
                [cells[firstStart], cells[firstEnd]],
                [cells[secondStart], cells[secondEnd]],
              ]
            : [[cells[start], cells[end]]];
        if (!intervals[0][0] || !intervals[0][1])
          warnings.push(
            `${context}: day ${(day + 1) % 7} has no complete hours.`,
          );
        for (const [opening, closing] of intervals) {
          if (!opening && !closing) continue;
          if (!opening || !closing) {
            warnings.push(
              `${context}: incomplete shift retained in private source.`,
            );
            continue;
          }
          const opensAt = clock(opening);
          const closesAt = clock(closing);
          const dayOfWeek = (day + 1) % 7;
          if (
            opensAt >= closesAt ||
            store.hours.some(
              (hour) =>
                hour.dayOfWeek === dayOfWeek &&
                opensAt < hour.closesAt &&
                closesAt > hour.opensAt,
            )
          ) {
            throw new Error(`${context}: overlapping or reversed hours.`);
          }
          store.hours.push({ dayOfWeek, opensAt, closesAt });
        }
      },
    );
    const userColumns = [
      ['AN', 'AO', 'AP', 'AQ', 'CP', 'CQ', 'CR', 'CS', 'CT', 'CU'],
      ['AR', 'AS', 'AT', 'AU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DA'],
      ['AV', 'AW', 'AX', 'AY', 'DB', 'DC', 'DD', 'DE', 'DF', 'DG'],
    ];
    for (const [
      name,
      email,
      mobile,
      role,
      newName,
      newEmail,
      newMobile,
      username,
      newRole,
      access,
    ] of userColumns) {
      const userName = cells[newName] ?? cells[name];
      if (!userName) continue;
      const userEmail = (cells[newEmail] ?? cells[email] ?? '').toLowerCase();
      if (
        userEmail.length > 180 ||
        !/^[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63})+$/.test(userEmail)
      ) {
        warnings.push(
          `${context}: ${name} has no valid access email; account pending.`,
        );
        continue;
      }
      const userRole = normalized(cells[newRole] ?? cells[role] ?? '');
      if (
        !['propietarioa', 'administradora', 'colaboradora'].includes(userRole)
      ) {
        warnings.push(
          `${context}: ${role} needs role review; account pending.`,
        );
        continue;
      }
      if (cells[access] && normalized(cells[access]) !== key) {
        warnings.push(
          `${context}: ${access} requests additional store access; manual review required.`,
        );
      }
      const userId = stableId(`user:${userEmail}`);
      store.users.push({
        id: userId,
        username: required(
          cells[username] ?? `onboarding.${userId.slice(0, 8)}`,
          context,
          60,
        ).toLowerCase(),
        displayName: required(userName, context, 120),
        email: required(userEmail, context, 180),
        phone:
          cells[newMobile] || cells[mobile]
            ? phone(cells[newMobile] ?? cells[mobile], context)
            : null,
        isOwner: userRole === 'propietarioa',
      });
    }
    stores.push(store);
  }
  const products: PlannedProduct[] = [];
  const skuSet = new Set<string>();
  for (const row of productSheet.rows) {
    const cells = row.cells;
    const context = `${productSheet.name}!${row.number}`;
    const store = stores.find(
      (item) => item.key === normalized(cells.H ?? cells.B ?? ''),
    );
    if (!store) {
      warnings.push(
        `${context}: store onboarding is missing; product retained in private source.`,
      );
      continue;
    }
    const name = required(cells.K ?? cells.E, context, 180);
    const candidates = normalizedSheet.rows.filter(
      (item) =>
        normalized(item.cells.C ?? '') === store.key &&
        normalized(item.cells.F ?? '') === normalized(name),
    );
    if (candidates.length > 1)
      throw new Error(`${context}: ambiguous normalized product.`);
    const externalId = candidates[0]?.cells.A;
    if (
      externalId &&
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(externalId)
    )
      throw new Error(`${context}: invalid product UUID.`);
    const id =
      externalId ?? stableId(`product:${store.key}:${normalized(name)}`);
    if (products.some((item) => item.id === id))
      throw new Error(`${context}: duplicate product.`);
    const wholesale = normalized(cells.AJ ?? cells.T ?? '') === 'si';
    const attributes: Record<string, string> = {};
    for (const [code, oldColumn, newColumn] of [
      ['material', 'O', 'AE'],
      ['fit', 'P', 'AF'],
      ['details', 'Q', 'AG'],
      ['care', 'R', 'AH'],
    ]) {
      const value = cells[newColumn] ?? cells[oldColumn];
      if (value) attributes[code] = value;
    }
    const countTime = cells.AM ?? cells.W;
    if (!countTime)
      warnings.push(
        `${context}: stock count date missing; submission date used, not import date.`,
      );
    attributes.stock_date_source = countTime ? 'declared' : 'submission';
    const product: PlannedProduct = {
      id,
      storeId: store.id,
      name,
      description: cells.AD ?? cells.N ?? null,
      category: required(cells.L ?? cells.F, context, 80),
      garmentType: required(cells.M ?? cells.G, context, 80),
      unitPriceInCents: cents(cells.AI ?? cells.S ?? '', context),
      wholesalePriceInCents: wholesale
        ? cents(cells.AK ?? cells.U ?? '', context)
        : null,
      wholesaleMinimum: wholesale
        ? integer(cells.AL ?? cells.V ?? '', context, 1)
        : null,
      attributes,
      stockUpdatedAt: localTimestamp(countTime ?? cells.A ?? '', context),
      variants: [],
    };
    const variantLines = (cells.AN ?? cells.X ?? '')
      .split(/\r?\n/)
      .filter((line) => line.trim());
    if (!variantLines.length)
      warnings.push(`${context}: no variant declarations.`);
    for (const [index, line] of variantLines.entries()) {
      const parts = line.split('|').map((part) => part.trim());
      if (
        parts.length < 3 ||
        parts.length > 4 ||
        !parts[0] ||
        !parts[1] ||
        !parts[2]
      ) {
        warnings.push(
          `${context}: variant line ${index + 1} incomplete; retained in private source.`,
        );
        continue;
      }
      const color = required(parts[0], context, 60);
      const sizeLabel = required(parts[1], context, 30);
      const sizeNormalized = ['standar', 'standard', 'unica', 'unico'].includes(
        normalized(sizeLabel),
      )
        ? 'UNICA'
        : sizeLabel.toUpperCase();
      const variantKey = `${id}:${normalized(color)}:${normalized(sizeNormalized)}`;
      const variantId = stableId(`variant:${variantKey}`);
      if (product.variants.some((item) => item.id === variantId))
        throw new Error(`${context}: duplicate size/color.`);
      const sku = required(parts[3] || `GAMI-${variantId}`, context, 80);
      if (skuSet.has(sku)) throw new Error(`${context}: duplicate SKU.`);
      skuSet.add(sku);
      product.variants.push({
        id: variantId,
        sku,
        color,
        sizeLabel,
        sizeNormalized,
        quantity: integer(parts[2], context),
      });
    }
    products.push(product);
  }
  const catalog = sheets.find((item) => item.name === 'Tiendas_Catalogo');
  for (const row of catalog?.rows ?? []) {
    if (!stores.some((store) => store.key === normalized(row.cells.A ?? '')))
      warnings.push(
        `Tiendas_Catalogo!${row.number}: name only; store creation pending contact details.`,
      );
  }
  return { stores, products, warnings };
}
