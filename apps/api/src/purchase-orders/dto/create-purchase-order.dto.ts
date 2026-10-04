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
import { Type } from 'class-transformer';
import Decimal from 'decimal.js';

export function IsPositiveDecimalString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPositiveDecimalString',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (value === undefined || value === null || value === '') return false;
          try {
            const d = new Decimal(value);
            return !d.isNaN() && d.gt(0);
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid strictly positive decimal number or string`;
        },
      },
    });
  };
}

export function IsNonNegativeDecimalString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNonNegativeDecimalString',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (value === undefined || value === null || value === '') return false;
          try {
            const d = new Decimal(value);
            return !d.isNaN() && d.gte(0);
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid non-negative decimal number or string`;
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
    description: 'Ordered quantity NUMERIC(18,4) (strictly positive decimal string or number)',
    example: '10',
    type: 'string',
  })
  @IsPositiveDecimalString()
  orderedQuantity: string | number;

  @ApiProperty({
    description: 'Unit price per quantity unit NUMERIC(18,4) (non-negative decimal string or number)',
    example: '15000000.00',
    type: 'string',
  })
  @IsNonNegativeDecimalString()
  unitPrice: string | number;

  @ApiPropertyOptional({
    description: 'Tax rate expressed as decimal fraction NUMERIC(7,4) (0.10 = 10%)',
    example: '0.10',
    default: '0',
    type: 'string',
  })
  @IsOptional()
  @IsNonNegativeDecimalString()
  taxRate?: string | number;
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
