import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class StoreHourDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  opensAt!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  closesAt!: string;
}

export class CreateStoreDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @Transform(trimmed)
  @IsString()
  @MaxLength(180)
  legalName!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  gallery!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  standNumber!: string;

  @Transform(trimmed)
  @Matches(/^\+[1-9]\d{7,14}$/)
  whatsappNumber!: string;

  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => StoreHourDto)
  hours!: StoreHourDto[];

  @Transform(trimmed)
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason!: string;
}

export class UpdateStoreDto extends CreateStoreDto {
  @IsDateString()
  updatedAt!: string;
}
