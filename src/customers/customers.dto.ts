import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  MinLength,
  MaxLength,
} from 'class-validator';

export class CustomerProfileDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 120)
  displayName!: string;

  @IsString()
  @Matches(/^\+?\d{7,15}$/)
  phone!: string;
}

export class RegisterCustomerDto extends CustomerProfileDto {
  @IsString()
  @Matches(/^9\d{8}$/, {
    message: 'El celular peruano debe tener nueve dígitos y comenzar en 9.',
  })
  declare phone: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(3, 60)
  @Matches(/^[a-z0-9._-]+$/)
  username!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(180)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;
}

export class CustomerCartQuantityDto {
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}
