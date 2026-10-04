import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
  MaxLength,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import Decimal from 'decimal.js';

/**
 * Ensures incoming raw values are strictly strings and not JavaScript numbers or other types.
 * Bypasses class-transformer implicit conversion so numbers like 10 or 1.25 are not auto-cast to string.
 */
export function StrictQuantityString() {
  return Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (raw === undefined || raw === null) return raw;
    if (typeof raw !== 'string') {
      return Symbol.for('INVALID_NON_STRING_DECIMAL');
    }
    return raw;
  });
}

interface QuantityValidationConstraint {
  maxIntegerDigits: number; // 14 for NUMERIC(18,4)
  maxScale: number; // 4
  min: 'gtZero' | 'gteZero';
}

function validateQuantityString(value: any, constraint: QuantityValidationConstraint): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // Strictly non-negative decimal digits without signs, exponent, or whitespace
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return false;
  }

  const [intPart, fracPart] = value.split('.');
  if (fracPart !== undefined && fracPart.length > constraint.maxScale) {
    return false;
  }

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

export function IsStrictPositiveQuantity(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrictPositiveQuantity',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return validateQuantityString(value, {
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

export function IsStrictNonNegativeQuantity(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrictNonNegativeQuantity',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return validateQuantityString(value, {
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

export class CreateGoodsReceiptItemDto {
  @ApiProperty({
    description: 'UUID of the corresponding purchase order item',
    example: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  })
  @IsUUID()
  purchaseOrderItemId: string;

  @ApiPropertyOptional({
    description: 'Manufacturer / batch lot identifier',
    example: 'LOT-2026-X99',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  lotNumber?: string;

  @ApiProperty({
    description: 'Gross physically received quantity NUMERIC(18,4) strictly positive decimal string',
    example: '50.0000',
    type: String,
  })
  @StrictQuantityString()
  @IsStrictPositiveQuantity()
  receivedQuantity: string;

  @ApiProperty({
    description: 'Inspected accepted quantity NUMERIC(18,4) non-negative decimal string',
    example: '45.0000',
    type: String,
  })
  @StrictQuantityString()
  @IsStrictNonNegativeQuantity()
  acceptedQuantity: string;

  @ApiProperty({
    description: 'Rejected / damaged quantity NUMERIC(18,4) non-negative decimal string',
    example: '5.0000',
    type: String,
  })
  @StrictQuantityString()
  @IsStrictNonNegativeQuantity()
  rejectedQuantity: string;

  @ApiPropertyOptional({
    description: 'Mandatory explanation note if rejectedQuantity > 0',
    example: '5 units packaging broken and water damaged',
  })
  @IsString()
  @IsOptional()
  damageNote?: string;
}

export class CreateGoodsReceiptDto {
  @ApiProperty({
    description: 'UUID of the target Purchase Order (must be in ISSUED or PARTIALLY_RECEIVED status)',
    example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  })
  @IsUUID()
  purchaseOrderId: string;

  @ApiPropertyOptional({
    description: 'Physical receipt timestamp (ISO 8601)',
    example: '2026-10-04T10:00:00.000Z',
  })
  @IsDateString()
  @IsOptional()
  receivedAt?: string;

  @ApiPropertyOptional({
    description: 'Optional warehouse receiving reference or delivery note code',
    example: 'BL-987654 delivery by FedEx',
  })
  @IsString()
  @IsOptional()
  referenceNote?: string;

  @ApiProperty({
    description: 'List of received line items (at least 1 line item required)',
    type: [CreateGoodsReceiptItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateGoodsReceiptItemDto)
  items: CreateGoodsReceiptItemDto[];
}
