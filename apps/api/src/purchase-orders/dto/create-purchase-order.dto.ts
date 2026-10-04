import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Matches,
  IsDateString,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import Decimal from 'decimal.js';

export function StrictDecimalString() {
  return Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (raw === undefined || raw === null) return raw;
    if (typeof raw !== 'string') {
      return Symbol.for('INVALID_NON_STRING_DECIMAL');
    }
    return raw;
  });
}

interface DecimalValidationConstraint {
  maxIntegerDigits: number; // 14 for NUMERIC(18,4), 3 for NUMERIC(7,4)
  maxScale: number; // 4
  min: 'gtZero' | 'gteZero';
}

function validateDecimalString(value: any, constraint: DecimalValidationConstraint): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // Must be strictly unsigned decimal digits without signs, exponent, or whitespace
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return false;
  }

  const [intPart, fracPart] = value.split('.');
  // Check scale constraint (max 4 decimal places)
  if (fracPart !== undefined && fracPart.length > constraint.maxScale) {
    return false;
  }

  // Check precision constraint (max integer digits excluding leading zeros)
  const strippedInt = intPart.replace(/^0+/, '') || '0';
  if (strippedInt !== '0' && strippedInt.length > constraint.maxIntegerDigits) {
    return false;
  }

  try {
    const d = new Decimal(value);
    if (d.isNaN()) return false;
    if (constraint.min === 'gtZero') {
      return d.gt(0);
    }
    return d.gte(0);
  } catch {
    return false;
  }
}

export function IsOrderedQuantityString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isOrderedQuantityString',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return validateDecimalString(value, {
            maxIntegerDigits: 14,
            maxScale: 4,
            min: 'gtZero',
          });
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid strictly positive decimal string with max 4 decimal places fitting NUMERIC(18,4)`;
        },
      },
    });
  };
}

export function IsUnitPriceString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isUnitPriceString',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return validateDecimalString(value, {
            maxIntegerDigits: 14,
            maxScale: 4,
            min: 'gteZero',
          });
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid non-negative decimal string with max 4 decimal places fitting NUMERIC(18,4)`;
        },
      },
    });
  };
}

export function IsTaxRateString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isTaxRateString',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return validateDecimalString(value, {
            maxIntegerDigits: 3,
            maxScale: 4,
            min: 'gteZero',
          });
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid non-negative decimal string with max 4 decimal places fitting NUMERIC(7,4)`;
        },
      },
    });
  };
}

export class CreatePurchaseOrderItemDto {
  @ApiPropertyOptional({ description: 'Stock Keeping Unit (SKU) identifier', example: 'LAPTOP-PRO-15' })
  @IsString()
  @IsOptional()
  sku?: string;

  @ApiProperty({ description: 'Detailed item line description', example: 'Dell Latitude 5540 15-inch Laptop' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({
    description: 'Ordered quantity NUMERIC(18,4) strictly positive decimal string with max 4 decimal places',
    example: '10.0000',
    type: String,
  })
  @StrictDecimalString()
  @IsOrderedQuantityString()
  orderedQuantity: string;

  @ApiProperty({
    description: 'Unit price per quantity unit NUMERIC(18,4) non-negative decimal string with max 4 decimal places',
    example: '15000000.0000',
    type: String,
  })
  @StrictDecimalString()
  @IsUnitPriceString()
  unitPrice: string;

  @ApiPropertyOptional({
    description: 'Tax rate expressed as decimal fraction NUMERIC(7,4) non-negative decimal string with max 4 decimal places (0.10 = 10%)',
    example: '0.1000',
    default: '0.0000',
    type: String,
  })
  @IsOptional()
  @StrictDecimalString()
  @IsTaxRateString()
  taxRate?: string;
}

export class CreatePurchaseOrderDto {
  @ApiProperty({ description: 'UUID of the target active supplier', example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  @IsUUID()
  supplierId: string;

  @ApiProperty({ description: '3-character transaction currency code', example: 'VND', default: 'VND' })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-character alphabetic code' })
  currency: string;

  @ApiProperty({ description: 'Order issuance date in YYYY-MM-DD format', example: '2026-10-04' })
  @IsDateString()
  orderDate: string;

  @ApiPropertyOptional({ description: 'Expected physical delivery date in YYYY-MM-DD format', example: '2026-10-18' })
  @IsDateString()
  @IsOptional()
  expectedDeliveryDate?: string;

  @ApiProperty({
    description: 'List of line items (at least 1 item required)',
    type: [CreatePurchaseOrderItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  items: CreatePurchaseOrderItemDto[];
}
