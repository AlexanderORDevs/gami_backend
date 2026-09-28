import { imageUrl, planWebCatalog } from './catalog-web.js';
import {
  readOnboardingWorkbook,
  type WorkbookSheet,
} from './onboarding-workbook.js';
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cover = 'https://res.cloudinary.com/djmtejkw7/image/upload/test.jpg';
function fixture(): WorkbookSheet[] {
  return [
    {
      name: 'Catálogo Web',
      headers: { A: 'Title' },
      rows: [
        {
          number: 3,
          cells: {
            A: 'id',
            E: 'nombre',
            I: 'precio_venta_S/',
            Q: 'img_portada_url',
            R: 'imgs_galeria_urls',
          },
        },
        { number: 4, cells: { A: 'N.º único', D: 'Marca', E: 'Nombre' } },
        {
          number: 5,
          cells: {
            A: '29',
            B: 'SÍ',
            C: 'marca_aliada',
            D: "D'MARCO",
            E: 'Casaca de paño',
            F: 'casacas',
            I: '135',
            N: 'S / M',
            O: 'Negro / Azul',
            P: '#111111 / #123456',
            Q: cover,
            R: `${cover} | https://res.cloudinary.com/djmtejkw7/image/upload/other.jpg`,
            K: '12',
            L: '90',
          },
        },
        { number: 6, cells: { A: '37' } },
      ],
    },
  ];
}

describe('complementary web catalog', () => {
  it('reads title/header layout, preserves source identity and deduplicates galleries without inventing stock', () => {
    const result = planWebCatalog(fixture());
    expect(result.products).toHaveLength(1);
    expect(result.products[0].images).toHaveLength(2);
    expect(result.products[0].sourceId).toBe('29');
    expect(result.products[0].price).toBe(13500);
    expect(result.products[0].attributes.declared_sizes).toEqual(['S', 'M']);
    expect(result.products[0].attributes).not.toHaveProperty('commission');
    expect(result.products[0]).not.toHaveProperty('variants');
    expect(result.warnings).toHaveLength(1);
  });
  it('respects inactive flags and rejects duplicates and unknown image hosts', () => {
    const sheets = fixture();
    sheets[0].rows[2].cells.B = 'NO';
    expect(planWebCatalog(sheets).products[0].active).toBe(false);
    sheets[0].rows.push({ ...sheets[0].rows[2], number: 7 });
    expect(() => planWebCatalog(sheets)).toThrow('duplicate');
    for (const url of [
      'http://localhost/image.jpg',
      'https://res.cloudinary.com/other/image/upload/test.jpg',
      'https://res.cloudinary.com@localhost/image.jpg',
    ])
      expect(() => imageUrl(url)).toThrow();
  });
  it('reads hyperlinks with rich display text and numerical formula results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gami-xlsx-'));
    try {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Links');
      sheet.addRow(['image', 'price']);
      sheet.getCell('A2').value = {
        text: { richText: [{ text: 'Photo' }] },
        hyperlink: cover,
      } as unknown as ExcelJS.CellValue;
      sheet.getCell('B2').value = { formula: '10+2', result: 12 };
      const file = join(directory, 'test.xlsx');
      await book.xlsx.writeFile(file);
      const result = await readOnboardingWorkbook(file);
      expect(result[0].rows[0].cells).toEqual({ A: cover, B: '12' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
