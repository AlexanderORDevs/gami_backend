import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderNumberParamDto {
  @IsString()
  @Length(1, 30)
  @Matches(/^[A-Za-z0-9-]+$/)
  orderNumber!: string;
}
export class ConfirmedItemDto {
  @IsUUID()
  orderItemId!: string;

  @IsInt()
  @Min(0)
  @Max(1000000)
  confirmedQuantity!: number;
}
export class OrderChangeDto {
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;

  @IsString()
  @Length(3, 255)
  @Matches(/\S/)
  reason!: string;
}
export class ConfirmStoreOrderDto extends OrderChangeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: ConfirmedItemDto) => item.orderItemId)
  @ValidateNested({ each: true })
  @Type(() => ConfirmedItemDto)
  items!: ConfirmedItemDto[];
}
export class AffectedItemDto {
  @IsUUID()
  orderItemId!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}
export const INCIDENT_TYPES = [
  'OUT_OF_STOCK',
  'ITEM_MISMATCH',
  'DAMAGED_ITEM',
  'OTHER',
] as const;
export class ReportOrderIncidentDto extends OrderChangeDto {
  @IsUUID()
  requestId!: string;

  @IsIn(INCIDENT_TYPES)
  type!: (typeof INCIDENT_TYPES)[number];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: AffectedItemDto) => item.orderItemId)
  @ValidateNested({ each: true })
  @Type(() => AffectedItemDto)
  items!: AffectedItemDto[];
}
export class ReviewOrderIncidentDto {
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;

  @IsString()
  @Length(3, 1000)
  @Matches(/\S/)
  note!: string;
}
