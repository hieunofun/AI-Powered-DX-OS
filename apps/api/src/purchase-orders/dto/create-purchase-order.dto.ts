import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsPositive,
  Min,
  IsUUID,
  Length,
  IsDateString,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePurchaseOrderItemDto {
  @ApiPropertyOptional({ description: 'Stock Keeping Unit (SKU) identifier', example: 'LAPTOP-PRO-15' })
  @IsString()
  @IsOptional()
  sku?: string;

  @ApiProperty({ description: 'Detailed item line description', example: 'Dell Latitude 5540 15-inch Laptop' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ description: 'Ordered quantity (must be strictly positive)', example: 10, minimum: 0.0001 })
  @IsNumber()
  @IsPositive()
  orderedQuantity: number;

  @ApiProperty({ description: 'Unit price per quantity unit', example: 15000000, minimum: 0 })
  @IsNumber()
  @Min(0)
  unitPrice: number;

  @ApiPropertyOptional({ description: 'Tax rate expressed as decimal fraction (0.10 = 10%)', example: 0.1, default: 0 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  taxRate?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty({ description: 'UUID of the target active supplier', example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  @IsUUID()
  supplierId: string;

  @ApiProperty({ description: 'ISO 4217 3-character transaction currency', example: 'VND', default: 'VND' })
  @IsString()
  @Length(3, 3)
  currency: string;

  @ApiProperty({ description: 'Order issuance date in YYYY-MM-DD format', example: '2026-10-04' })
  @IsDateString()
  orderDate: string;

  @ApiPropertyOptional({ description: 'Expected physical delivery date in YYYY-MM-DD format', example: '2026-10-18' })
  @IsDateString()
  @IsOptional()
  expectedDeliveryDate?: string;

  @ApiProperty({
    description: 'List of order line items (at least 1 item required)',
    type: [CreatePurchaseOrderItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  items: CreatePurchaseOrderItemDto[];
}
