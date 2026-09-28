import {
  legacyReferenceImage,
  referenceImageFor,
  refreshReferenceImages,
} from './onboarding-images.js';
import type { Prisma } from '../src/generated/prisma/client.js';

describe('onboarding reference images', () => {
  it('assigns distinct HTTPS references and only replaces the tagged legacy placeholder', async () => {
    const ids = [
      'b8d5b76a-4fca-4079-98dc-f21074515f87',
      '758bd43a-d277-4c32-b46d-c9167a65882b',
      '2ffa2554-7d99-4016-a19d-c75474e4b4d1',
      '6a369681-14ec-4f86-b3ce-2ac8d188819e',
      '8b88be24-33b1-4b6b-b198-4f85afa9cc3e',
      '90c5dcae-f089-4c15-b58d-e8d531c57b7b',
    ];
    expect(new Set(ids.map(referenceImageFor)).size).toBe(6);
    expect(
      ids.every((id) => new URL(referenceImageFor(id)).protocol === 'https:'),
    ).toBe(true);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      productAttribute: { updateMany },
    } as unknown as Prisma.TransactionClient;
    expect(await refreshReferenceImages(transaction, ids)).toBe(6);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      productId: ids[0],
      code: 'image_url',
      value: legacyReferenceImage,
      product: {
        deletedAt: null,
        status: { in: ['DRAFT', 'UNDER_REVIEW', 'CHANGES_REQUESTED'] },
        productAttributes: {
          some: {
            code: 'image_kind',
            value: 'reference_only_not_actual_product',
          },
        },
      },
    });
    updateMany.mockResolvedValue({ count: 0 });
    expect(await refreshReferenceImages(transaction, ids)).toBe(0);
    expect(referenceImageFor('unknown')).toBe(legacyReferenceImage);
  });
});
import {
  cents,
  integer,
  normalized,
  planOnboarding,
  stableId,
  type WorkbookSheet,
} from './onboarding-workbook.js';

function fixture(): WorkbookSheet[] {
  return [
    {
      name: 'Form Responses 1',
      headers: {
        H: 'Nombre comercial2',
        O: 'WhatsApp principal',
        AQ: 'Usuario 1 — rol',
      },
      rows: [
        {
          number: 2,
          cells: {
            H: 'DMarco',
            O: '912345678',
            R: 'Sí',
            S: '1899-12-30T10:00:00.000Z',
            T: '1899-12-30T20:00:00.000Z',
            AN: 'Operator',
            AO: 'operator@example.test',
            AQ: 'Administrador/a',
          },
        },
      ],
    },
    {
      name: 'Form Responses 2',
      headers: { K: 'Nombre / modelo del producto 2', X: 'Variantes y stock' },
      rows: [
        {
          number: 2,
          cells: {
            A: '2026-09-25T12:00:00.000Z',
            H: "D'MARCO",
            K: 'Top',
            L: 'Mujer',
            M: 'Top',
            S: '14.50',
            X: 'Negro | Standar | 5\nRojo | S | 12\nAzul',
          },
        },
      ],
    },
    {
      name: 'Productos_Normalizados',
      headers: { A: 'ID carga', C: 'Tienda', F: 'Producto / modelo' },
      rows: [],
    },
  ];
}

describe('onboarding workbook', () => {
  it('matches punctuation aliases, imports explicit variants, and preserves missing data as warnings', () => {
    const plan = planOnboarding(fixture());
    expect(plan.stores).toHaveLength(1);
    expect(plan.products[0].variants).toHaveLength(2);
    expect(plan.products[0].unitPriceInCents).toBe(1450);
    expect(plan.products[0].variants[0].sizeNormalized).toBe('UNICA');
    expect(plan.products[0].stockUpdatedAt.toISOString()).toBe(
      '2026-09-25T17:00:00.000Z',
    );
    expect(plan.stores[0].hours[0].opensAt.toISOString()).toBe(
      '1970-01-01T10:00:00.000Z',
    );
    expect(plan.stores[0].users[0].isOwner).toBe(false);
    expect(plan.warnings).toHaveLength(2);
    expect(planOnboarding(fixture())).toEqual(plan);
  });
  it('rejects changed headers rather than importing shifted columns', () => {
    const sheets = fixture();
    sheets[1].headers.X = 'Other';
    expect(() => planOnboarding(sheets)).toThrow('unexpected header');
  });
  it('rejects duplicate variants and negative stock', () => {
    const sheets = fixture();
    sheets[1].rows[0].cells.X = 'Negro | S | 1\nNegro | S | 2';
    expect(() => planOnboarding(sheets)).toThrow('duplicate size/color');
    sheets[1].rows[0].cells.X = 'Negro | S | -1';
    expect(() => planOnboarding(sheets)).toThrow('expected an integer');
  });
  it('does not substitute the store email for a missing user email or infer closed days', () => {
    const sheets = fixture();
    delete sheets[0].rows[0].cells.AO;
    sheets[0].rows[0].cells.P = 'store@example.test';
    sheets[0].rows[0].cells.U = 'Sí';
    const plan = planOnboarding(sheets);
    expect(plan.stores[0].users).toHaveLength(0);
    expect(plan.stores[0].hours).toHaveLength(1);
    expect(
      plan.warnings.some((warning) => warning.includes('account pending')),
    ).toBe(true);
  });
  it('rejects invalid money and quantities and generates stable identity', () => {
    expect(cents('13,25', 'price')).toBe(1325);
    for (const value of ['', 'NaN', '-1', '1.234'])
      expect(() => cents(value, 'price')).toThrow();
    expect(() => integer('1.5', 'stock')).toThrow();
    expect(normalized("D'MARCO")).toBe(normalized('DMarco'));
    expect(stableId('test')).toBe(stableId('test'));
  });
});
