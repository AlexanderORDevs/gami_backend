import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'alexander' })
  @IsString()
  @Length(3, 60)
  username!: string;

  @ApiProperty({ example: 'temporary-password' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Opaque refresh token returned by login or refresh.',
  })
  @IsString()
  @MinLength(32)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({
    description:
      'Required for established passwords; omitted when completing a temporary-password session.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  currentPassword?: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  newPassword!: string;
}

export class RecoverPasswordDto {
  @ApiProperty({
    example: 'name@example.com',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(180)
  email!: string;

  @ApiProperty({
    description: 'One-time code sent to the account email address.',
  })
  @IsString()
  @MinLength(12)
  recoveryCode!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  newPassword!: string;
}

export class RequestPasswordResetDto {
  @ApiProperty({ example: 'name@example.com' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(180)
  email!: string;
}

export class RequestPasswordResetResponseDto {
  @ApiProperty()
  message!: string;
}

export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: 900 })
  expiresIn!: number;
}

export class AuthUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ type: [String] })
  roles!: string[];

  @ApiProperty({ type: [String] })
  storeIds!: string[];

  @ApiProperty()
  mustChangePassword!: boolean;
}

export class AuthResponseDto {
  @ApiProperty({ type: AuthTokensDto })
  tokens!: AuthTokensDto;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class PasswordChangeResponseDto extends AuthResponseDto {
  @ApiProperty({
    type: [String],
    description:
      'One-time recovery codes. They are shown only in this response.',
  })
  recoveryCodes!: string[];
}
