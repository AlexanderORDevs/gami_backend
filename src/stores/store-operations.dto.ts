import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AddressZoneType } from '../generated/prisma/client.js';

export const PRODUCT_TYPES = {
  superior: ['camisa', 'blusa', 'polo', 'top', 'chompa'],
  inferior: ['jean', 'pantalon_recto', 'pantalon_wide', 'falda'],
  vestido: ['vestido'],
  abrigo: ['casaca', 'abrigo'],
  calzado: ['zapatilla', 'zapato', 'sandalia'],
  accesorio: ['bolso', 'correa', 'gorro'],
};
export const PRODUCT_COLORS = [
  'negro',
  'blanco',
  'beige',
  'gris',
  'navy',
  'azul',
  'rojo',
  'verde',
  'amarillo',
  'rosado',
  'morado',
  'marron',
  'naranja',
  'multicolor',
];
export const PRODUCT_OPTIONS = {
  types: PRODUCT_TYPES,
  colors: PRODUCT_COLORS,
  genders: ['mujer', 'hombre', 'unisex'],
  patterns: ['liso', 'rayas', 'estampado', 'cuadros', 'denim'],
  fits: ['ajustado', 'regular', 'holgado', 'oversize'],
  lengths: ['corto', 'medio', 'largo'],
};

export class ProductVariantInput {
  @IsString()
  @Length(1, 30)
  @Matches(/\S/)
  sizeLabel!: string;

  @IsString()
  @Length(1, 60)
  @IsIn(PRODUCT_COLORS)
  color!: string;

  @IsInt()
  @Min(0)
  @Max(1000000)
  quantity!: number;
}

export class CreateStoreProductDto {
  @IsString()
  @Length(3, 180)
  @Matches(/\S/)
  name!: string;

  @IsString()
  @Length(10, 5000)
  @Matches(/\S/)
  description!: string;

  @IsString()
  @Length(2, 80)
  @IsIn(Object.keys(PRODUCT_TYPES))
  category!: string;

  @IsString()
  @Length(2, 80)
  @IsIn(Object.values(PRODUCT_TYPES).flat())
  garmentType!: string;

  @IsIn(PRODUCT_OPTIONS.genders)
  gender!: string;

  @IsIn(PRODUCT_COLORS)
  mainColor!: string;

  @IsIn(PRODUCT_OPTIONS.patterns)
  pattern!: string;

  @IsIn(PRODUCT_OPTIONS.fits)
  fit!: string;

  @IsOptional()
  @IsIn(PRODUCT_OPTIONS.lengths)
  length?: string;

  @IsInt()
  @Min(1)
  @Max(100000000)
  unitPriceInCents!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000000)
  wholesalePriceInCents?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(1000000)
  wholesaleMinimum?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  @Length(1, 180, { each: true })
  imageUrls!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantInput)
  variants!: ProductVariantInput[];
}

export class AdjustStoreInventoryDto {
  @IsInt()
  @Min(0)
  @Max(1000000)
  quantity!: number;

  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  expectedQuantity!: number | null;

  @IsString()
  @Length(3, 255)
  @Matches(/\S/)
  reason!: string;
}

export class StoreOrderItemInput {
  @IsUUID()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}

export class CreateStoreOrderDto {
  @IsString()
  @Length(3, 150)
  @Matches(/\S/)
  customerName!: string;

  @IsString()
  @Matches(/^\+?\d{7,15}$/)
  customerPhone!: string;

  @IsOptional()
  @IsEmail()
  @Length(3, 180)
  customerEmail?: string;

  @IsString()
  @Length(3, 150)
  @Matches(/\S/)
  recipientName!: string;

  @IsString()
  @Matches(/^\+?\d{7,15}$/)
  recipientPhone!: string;

  @IsEnum(AddressZoneType)
  zoneType!: AddressZoneType;

  @IsString()
  @Length(2, 100)
  @Matches(/\S/)
  city!: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  @Matches(/\S/)
  district?: string;

  @IsOptional()
  @IsString()
  @Length(2, 150)
  @Matches(/\S/)
  agency?: string;

  @IsString()
  @Length(5, 255)
  @Matches(/\S/)
  line1!: string;

  @IsOptional()
  @IsString()
  @Length(3, 255)
  @Matches(/\S/)
  reference?: string;

  @IsInt()
  @Min(0)
  @Max(100000000)
  shippingInCents!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: StoreOrderItemInput) => item.variantId)
  @ValidateNested({ each: true })
  @Type(() => StoreOrderItemInput)
  items!: StoreOrderItemInput[];
}

export class CreateStoreShipmentDto {
  @IsUUID()
  orderId!: string;

  @IsString()
  @Length(2, 60)
  @Matches(/\S/)
  method!: string;

  @IsString()
  @Length(2, 80)
  @Matches(/\S/)
  provider!: string;

  @IsOptional()
  @IsString()
  @Length(2, 120)
  @Matches(/\S/)
  trackingCode?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsISO8601({ strict: true })
  pickupScheduledAt?: string;
}
