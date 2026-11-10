import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CATALOG_AUDIENCES } from './catalog-taxonomy.js';

export class CatalogQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLocaleLowerCase('es-PE') : value,
  )
  @IsOptional()
  @IsIn(CATALOG_AUDIENCES)
  gender?: (typeof CATALOG_AUDIENCES)[number];

  @IsOptional()
  @IsUUID()
  storeId?: string;

  @IsIn(['newest', 'price-asc', 'price-desc'])
  sort: 'newest' | 'price-asc' | 'price-desc' = 'newest';
}
