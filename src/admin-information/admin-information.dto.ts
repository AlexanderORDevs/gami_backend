import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AddressZoneType } from '../generated/prisma/client.js';

export class InformationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class RegisterPayoutDto {
  @IsUUID()
  requestId!: string;

  @IsUUID()
  storeId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  amountInCents!: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledAt?: string;

  @IsString()
  @Length(3, 255)
  @Matches(/\S/)
  reason!: string;
}

export class CreateShippingRateDto {
  @IsEnum(AddressZoneType)
  zoneType!: AddressZoneType;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && !value.trim() ? null : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  minItems!: number;

  @Transform(({ value }: { value: unknown }) =>
    value === '' || value === null ? undefined : value,
  )
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxItems?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  rateInCents!: number;

  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveTo?: string;

  @IsString()
  @Length(3, 255)
  @Matches(/\S/)
  reason!: string;
}

export class UpsertCalendarDayDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsBoolean()
  isWorkingDay!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  description?: string;

  @IsString()
  @Length(3, 255)
  @Matches(/\S/)
  reason!: string;
}
