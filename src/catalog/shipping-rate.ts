import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, AddressZoneType } from '../generated/prisma/client.js';

export async function resolveShippingRate(
  transaction: Prisma.TransactionClient,
  zoneType: AddressZoneType,
  district: string | undefined,
  units: number,
  now = new Date(),
) {
  if (zoneType === 'LIMA' && !district?.trim())
    throw new BadRequestException('Selecciona el distrito de entrega.');

  const eligible = await transaction.shippingRate.findMany({
    where: {
      zoneType,
      active: true,
      currency: 'PEN',
      minItems: { lte: units },
      effectiveFrom: { lte: now },
      AND: [
        { OR: [{ maxItems: null }, { maxItems: { gte: units } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      ],
    },
    select: { district: true, rateInCents: true },
  });
  const normalizedDistrict = district?.trim().toLocaleLowerCase('es-PE');
  const exact = eligible.filter(
    (rate) =>
      rate.district?.trim().toLocaleLowerCase('es-PE') === normalizedDistrict &&
      rate.district !== null,
  );
  const matches = exact.length
    ? exact
    : eligible.filter((rate) => rate.district === null);
  if (matches.length !== 1 || matches[0].rateInCents < 0)
    throw new ConflictException(
      'Tarifa de envío no disponible para este destino y cantidad de prendas.',
    );
  return matches[0].rateInCents;
}
