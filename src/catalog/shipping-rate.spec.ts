import { ConflictException } from '@nestjs/common';
import { resolveShippingRate } from './shipping-rate.js';

function transaction(
  rates: { district: string | null; rateInCents: number }[],
) {
  return {
    shippingRate: { findMany: vi.fn().mockResolvedValue(rates) },
  };
}

it('prefers a matching district tariff and falls back to one zone tariff', async () => {
  const district = transaction([
    { district: null, rateInCents: 900 },
    { district: 'La Victoria', rateInCents: 1200 },
    { district: 'Miraflores', rateInCents: 1500 },
  ]);
  await expect(
    resolveShippingRate(
      district as never,
      'LIMA',
      ' la victoria ',
      2,
      new Date('2026-11-09T12:00:00Z'),
    ),
  ).resolves.toBe(1200);

  const generic = transaction([{ district: null, rateInCents: 900 }]);
  await expect(
    resolveShippingRate(
      generic as never,
      'LIMA',
      'Barranco',
      1,
      new Date('2026-11-09T12:00:00Z'),
    ),
  ).resolves.toBe(900);
});

it('rejects missing and ambiguous applicable tariffs', async () => {
  await expect(
    resolveShippingRate(transaction([]) as never, 'PROVINCE', undefined, 1),
  ).rejects.toBeInstanceOf(ConflictException);
  await expect(
    resolveShippingRate(
      transaction([
        { district: null, rateInCents: 900 },
        { district: null, rateInCents: 1000 },
      ]) as never,
      'PROVINCE',
      undefined,
      1,
    ),
  ).rejects.toBeInstanceOf(ConflictException);
});
