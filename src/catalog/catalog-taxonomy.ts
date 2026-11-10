export const CATALOG_AUDIENCES = ['mujer', 'hombre', 'unisex'] as const;
export type CatalogAudience = (typeof CATALOG_AUDIENCES)[number];

const CATEGORY_GROUPS: Record<string, string[]> = {
  tops: ['top', 'tops', 'blusa', 'blusas', 'camisa', 'camisas'],
  polos: ['polo', 'polos'],
  chompas: ['chompa', 'chompas'],
  pantalones: [
    'pantalon',
    'pantalón',
    'pantalones',
    'pantalon_recto',
    'pantalon_wide',
    'jean',
    'jeans',
  ],
  faldas: ['falda', 'faldas'],
  vestidos: ['vestido', 'vestidos'],
  casacas: ['casaca', 'casacas', 'abrigo', 'abrigos'],
  conjuntos: ['conjunto', 'conjuntos'],
  calzado: [
    'zapatilla',
    'zapatillas',
    'zapato',
    'zapatos',
    'sandalia',
    'sandalias',
  ],
  accesorios: ['bolso', 'bolsos', 'correa', 'correas', 'gorro', 'gorros'],
};
const CATEGORY_BY_ALIAS = new Map(
  Object.entries(CATEGORY_GROUPS).flatMap(([category, aliases]) =>
    aliases.map((alias) => [alias, category] as const),
  ),
);

export function normalizeTaxonomyToken(value: string) {
  return value
    .trim()
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-PE')
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '');
}

export function canonicalProductCategory(
  category: string,
  garmentType = category,
) {
  const garmentToken = normalizeTaxonomyToken(garmentType);
  const categoryToken = normalizeTaxonomyToken(category);
  return (
    CATEGORY_BY_ALIAS.get(garmentToken) ??
    CATEGORY_BY_ALIAS.get(categoryToken) ??
    categoryToken
  );
}

function normalizedAudience(value: unknown): CatalogAudience | null {
  if (typeof value !== 'string') return null;
  const token = normalizeTaxonomyToken(value);
  if (
    ['mujer', 'femenino', 'femenina', 'female', 'women', 'woman'].includes(
      token,
    )
  )
    return 'mujer';
  if (
    ['hombre', 'masculino', 'masculina', 'male', 'men', 'man'].includes(token)
  )
    return 'hombre';
  if (['unisex', 'neutro', 'neutra'].includes(token)) return 'unisex';
  return null;
}

export function catalogAudience(category: string, attributes: unknown) {
  if (
    attributes &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes)
  ) {
    const values = attributes as Record<string, unknown>;
    const storedAudience =
      normalizedAudience(values.genero) ??
      normalizedAudience(values.gender) ??
      normalizedAudience(values.audience);
    if (storedAudience) return storedAudience;
  }
  return normalizedAudience(category);
}

export function categoryAliases(category: string) {
  const canonical = canonicalProductCategory(category, category);
  return CATEGORY_GROUPS[canonical] ?? [normalizeTaxonomyToken(category)];
}
