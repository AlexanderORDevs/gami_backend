import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const;

export class CreateUserDto {
  @ApiProperty({ example: 'store.operator' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(3, 60)
  username!: string;

  @ApiProperty({ example: 'Store Operator' })
  @IsString()
  @Length(1, 120)
  displayName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(180)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class UserListQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: (typeof USER_STATUSES)[number];
}

export class UserAuditQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ example: 'USER_ROLE_GRANTED' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: USER_STATUSES })
  @IsIn(USER_STATUSES)
  status!: (typeof USER_STATUSES)[number];

  @ApiProperty({ description: 'Required audit justification.' })
  @IsString()
  @Length(3, 255)
  reason!: string;
}

export class RoleCodeDto {
  @ApiProperty({ example: 'CATALOG_MANAGER' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(2, 50)
  roleCode!: string;

  @ApiProperty({ description: 'Required audit justification.' })
  @IsString()
  @Length(3, 255)
  reason!: string;
}

export class StoreMembershipDto {
  @ApiProperty()
  @IsUUID()
  storeId!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isOwner = false;

  @ApiProperty({ description: 'Required audit justification.' })
  @IsString()
  @Length(3, 255)
  reason!: string;
}

export class AuditReasonDto {
  @ApiProperty({ description: 'Required audit justification.' })
  @IsString()
  @Length(3, 255)
  reason!: string;
}

export class UserStoreMembershipDto {
  @ApiProperty()
  storeId!: string;

  @ApiProperty()
  storeName!: string;

  @ApiProperty()
  isOwner!: boolean;

  @ApiProperty()
  active!: boolean;
}

export class UserResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  displayName!: string;

  @ApiPropertyOptional()
  email!: string | null;

  @ApiPropertyOptional()
  phone!: string | null;

  @ApiProperty({ enum: USER_STATUSES })
  status!: string;

  @ApiProperty()
  mustChangePassword!: boolean;

  @ApiPropertyOptional()
  lastLoginAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ type: [String] })
  roles!: string[];

  @ApiProperty({ type: [UserStoreMembershipDto] })
  storeMemberships!: UserStoreMembershipDto[];
}

export class UserListResponseDto {
  @ApiProperty({ type: [UserResponseDto] })
  data!: UserResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  pages!: number;
}

export class TemporaryPasswordResponseDto {
  @ApiProperty({ description: 'Shown once. Deliver through a secure channel.' })
  temporaryPassword!: string;

  @ApiProperty()
  mustChangePassword!: boolean;
}

export class UserAuditEntryDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional()
  actorUserId!: string | null;

  @ApiProperty()
  action!: string;

  @ApiPropertyOptional()
  fromState!: string | null;

  @ApiPropertyOptional()
  toState!: string | null;

  @ApiPropertyOptional()
  reason!: string | null;

  @ApiProperty()
  channel!: string;

  @ApiPropertyOptional({ type: Object })
  metadata!: unknown;

  @ApiProperty()
  occurredAt!: Date;
}

export class UserAuditListResponseDto {
  @ApiProperty({ type: [UserAuditEntryDto] })
  data!: UserAuditEntryDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  pages!: number;
}
