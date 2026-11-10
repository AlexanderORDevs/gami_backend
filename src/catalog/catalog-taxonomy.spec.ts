import {
  canonicalProductCategory,
  catalogAudience,
  categoryAliases,
} from './catalog-taxonomy.js';

it('derives clothing type from garmentType when the legacy category stores audience', () => {
  expect(canonicalProductCategory('Mujer', 'Top')).toBe('tops');
  expect(canonicalProductCategory('Hombre', 'Pantalón')).toBe('pantalones');
  expect(canonicalProductCategory('tops', 'tops')).toBe('tops');
  expect(categoryAliases('tops')).toEqual([
    'top',
    'tops',
    'blusa',
    'blusas',
    'camisa',
    'camisas',
  ]);
});

it('normalizes audience labels from structured attributes or legacy categories', () => {
  expect(catalogAudience('tops', { genero: 'mujer' })).toBe('mujer');
  expect(catalogAudience('tops', { gender: 'Female' })).toBe('mujer');
  expect(catalogAudience('Mujer', null)).toBe('mujer');
  expect(catalogAudience('Hombre', null)).toBe('hombre');
  expect(catalogAudience('tops', { private: 'ignored' })).toBeNull();
});
