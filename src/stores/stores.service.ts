import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedUser, RequestContext } from '../auth/auth.types.js';
import type {
  CreateStoreDto,
  StoreHourDto,
  UpdateStoreDto,
} from './stores.dto.js';

const STORE_SELECT = {
  id: true,
  displayName: true,
  legalName: true,
  gallery: true,
  standNumber: true,
  whatsappNumber: true,
  whatsappVerifiedAt: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  hours: {
    orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
    select: { dayOfWeek: true, opensAt: true, closesAt: true },
  },
  members: {
    where: { active: true },
    select: {
      userId: true,
      isOwner: true,
      user: { select: { displayName: true, username: true, status: true } },
    },
  },
} as const satisfies Prisma.StoreSelect;

type SelectedStore = Prisma.StoreGetPayload<{ select: typeof STORE_SELECT }>;

function serialize(store: SelectedStore) {
  return {
    ...store,
    hours: store.hours.map((hour) => ({
      ...hour,
      opensAt: hour.opensAt.toISOString().slice(11, 16),
      closesAt: hour.closesAt.toISOString().slice(11, 16),
    })),
  };
}

function validatedHours(hours: StoreHourDto[]) {
  const sorted = [...hours].sort(
    (first, second) =>
      first.dayOfWeek - second.dayOfWeek ||
      first.opensAt.localeCompare(second.opensAt),
  );
  for (const [index, hour] of sorted.entries()) {
    if (hour.opensAt >= hour.closesAt)
      throw new BadRequestException(
        'La hora de cierre debe ser posterior a la apertura.',
      );
    const previous = sorted[index - 1];
    if (
      previous?.dayOfWeek === hour.dayOfWeek &&
      previous.closesAt > hour.opensAt
    ) {
      throw new BadRequestException(
        'Los turnos del mismo día no pueden superponerse.',
      );
    }
  }
  return sorted.map((hour) => ({
    dayOfWeek: hour.dayOfWeek,
    opensAt: new Date(`1970-01-01T${hour.opensAt}:00Z`),
    closesAt: new Date(`1970-01-01T${hour.closesAt}:00Z`),
  }));
}

function fields(input: CreateStoreDto) {
  return {
    displayName: input.displayName,
    legalName: input.legalName || null,
    gallery: input.gallery,
    standNumber: input.standNumber,
    whatsappNumber: input.whatsappNumber,
  };
}

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async detail(id: string) {
    const store = await this.prisma.store.findFirst({
      where: { id, deletedAt: null },
      select: STORE_SELECT,
    });
    if (!store) throw new NotFoundException('No se encontró la tienda.');
    return serialize(store);
  }

  async create(
    input: CreateStoreDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const hours = validatedHours(input.hours);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const store = await transaction.store.create({
          data: {
            ...fields(input),
            status: 'APPLIED',
            hours: { create: hours },
          },
          select: STORE_SELECT,
        });
        await this.audit(
          transaction,
          store.id,
          'STORE_CREATED',
          input.reason,
          actor,
          context,
          Object.keys(fields(input)).concat('hours'),
        );
        return serialize(store);
      });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async update(
    id: string,
    input: UpdateStoreDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const hours = validatedHours(input.hours);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.store.findFirst({
          where: { id, deletedAt: null },
          select: STORE_SELECT,
        });
        if (!existing) throw new NotFoundException('No se encontró la tienda.');
        if (['CLOSED', 'REJECTED'].includes(existing.status))
          throw new BadRequestException(
            'Una tienda cerrada o rechazada no admite cambios.',
          );
        if (existing.status === 'ACTIVE' && !hours.length)
          throw new BadRequestException(
            'Una tienda activa debe conservar al menos un horario.',
          );
        const changedFields = Object.entries(fields(input))
          .filter(
            ([key, value]) => existing[key as keyof SelectedStore] !== value,
          )
          .map(([key]) => key);
        if (
          JSON.stringify(serialize(existing).hours) !==
          JSON.stringify(
            hours.map((hour) => ({
              ...hour,
              opensAt: hour.opensAt.toISOString().slice(11, 16),
              closesAt: hour.closesAt.toISOString().slice(11, 16),
            })),
          )
        )
          changedFields.push('hours');
        const changed = await transaction.store.updateMany({
          where: { id, deletedAt: null, updatedAt: new Date(input.updatedAt) },
          data: {
            ...fields(input),
            updatedAt: new Date(
              Math.max(Date.now(), existing.updatedAt.getTime() + 1),
            ),
            ...(input.whatsappNumber !== existing.whatsappNumber
              ? { whatsappVerifiedAt: null }
              : {}),
          },
        });
        if (changed.count !== 1)
          throw new ConflictException(
            'La tienda cambió desde que la abriste. Recarga el detalle antes de guardar.',
          );
        await transaction.storeHour.deleteMany({ where: { storeId: id } });
        if (hours.length)
          await transaction.storeHour.createMany({
            data: hours.map((hour) => ({ ...hour, storeId: id })),
          });
        await this.audit(
          transaction,
          id,
          'STORE_UPDATED',
          input.reason,
          actor,
          context,
          changedFields,
        );
        return serialize(
          await transaction.store.findUniqueOrThrow({
            where: { id },
            select: STORE_SELECT,
          }),
        );
      });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async history(id: string) {
    await this.detail(id);
    const entries = await this.prisma.auditLog.findMany({
      where: { entityType: 'store', entityId: id },
      take: 20,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        action: true,
        reason: true,
        occurredAt: true,
        actorUser: { select: { displayName: true } },
      },
    });
    return entries.map(({ id: entryId, actorUser, ...entry }) => ({
      ...entry,
      id: String(entryId),
      actor: actorUser?.displayName ?? null,
    }));
  }

  private async audit(
    transaction: Prisma.TransactionClient,
    id: string,
    action: string,
    reason: string,
    actor: AuthenticatedUser,
    context: RequestContext,
    changedFields: string[],
  ) {
    await transaction.auditLog.create({
      data: {
        entityType: 'store',
        entityId: id,
        action,
        actorUserId: actor.userId,
        channel: 'ADMIN_PANEL',
        reason,
        metadata: {
          changedFields,
          ipAddress: context.ipAddress ?? 'unknown',
          userAgent: context.userAgent ?? 'unknown',
        },
      },
    });
  }

  private rethrow(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      throw new ConflictException(
        'Ese número de WhatsApp ya está registrado en otra tienda.',
      );
    throw error;
  }
}
