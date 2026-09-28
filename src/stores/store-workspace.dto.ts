import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsString, Length } from 'class-validator';
import { StoreMemberRole } from '../generated/prisma/client.js';
import { CreateUserDto } from '../users/dto/users.dto.js';

export enum StoreInformationResource {
  products = 'products',
  inventory = 'inventory',
  orders = 'orders',
  shipments = 'shipments',
  payouts = 'payouts',
  ledger = 'ledger',
}

export class CreateStoreUserDto extends PickType(CreateUserDto, [
  'username',
  'displayName',
  'email',
  'phone',
  'storeRole',
] as const) {}

export class UpdateStoreMemberDto {
  @ApiProperty({ enum: StoreMemberRole })
  @IsEnum(StoreMemberRole)
  role!: StoreMemberRole;

  @ApiProperty()
  @IsBoolean()
  active!: boolean;

  @ApiProperty()
  @IsString()
  @Length(3, 255)
  reason!: string;
}
