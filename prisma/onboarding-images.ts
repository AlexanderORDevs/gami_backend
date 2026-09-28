import type { Prisma } from '../src/generated/prisma/client.js';

export const legacyReferenceImage =
  'https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?w=800&auto=format&fit=crop&q=80';

const referencePhotos: Record<string, string> = {
  'b8d5b76a-4fca-4079-98dc-f21074515f87': '1543076447-215ad9ba6923',
  '758bd43a-d277-4c32-b46d-c9167a65882b': '1473966968600-fa801b869a1a',
  '2ffa2554-7d99-4016-a19d-c75474e4b4d1': '1624378439575-d8705ad7ae80',
  '6a369681-14ec-4f86-b3ce-2ac8d188819e': '1503341504253-dff4815485f1',
  '8b88be24-33b1-4b6b-b198-4f85afa9cc3e': '1521572163474-6864f9cf17ab',
  '90c5dcae-f089-4c15-b58d-e8d531c57b7b': '1554568218-0f1715e72254',
};

export function referenceImageFor(productId: string): string {
  const photo = referencePhotos[productId];
  return photo
    ? `https://images.unsplash.com/photo-${photo}?w=800&auto=format&fit=crop&q=80`
    : legacyReferenceImage;
}

export async function refreshReferenceImages(
  transaction: Prisma.TransactionClient,
  productIds: string[],
): Promise<number> {
  let updated = 0;
  for (const productId of productIds) {
    const value = referenceImageFor(productId);
    if (value === legacyReferenceImage) continue;
    const result = await transaction.productAttribute.updateMany({
      where: {
        productId,
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
      },
      data: { value },
    });
    updated += result.count;
  }
  return updated;
}
