import { PickType } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { CreateStoreOrderDto } from '../stores/store-operations.dto.js';

export class CheckoutQuoteDto extends PickType(CreateStoreOrderDto, [
  'items',
  'zoneType',
  'district',
] as const) {}

export class CheckoutOrderDto extends PickType(CreateStoreOrderDto, [
  'items',
  'zoneType',
  'city',
  'district',
  'agency',
  'line1',
  'reference',
  'customerName',
  'customerPhone',
  'customerEmail',
  'recipientName',
  'recipientPhone',
] as const) {
  @IsUUID()
  requestId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedSubtotalInCents!: number;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedShippingInCents!: number;
}
