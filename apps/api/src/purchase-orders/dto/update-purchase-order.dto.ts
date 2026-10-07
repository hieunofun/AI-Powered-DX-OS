import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  IsUUID,
  Matches,
  IsDateString,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreatePurchaseOrderItemDto } from './create-purchase-order.dto';

export class UpdatePurchaseOrderDto {
  @ApiProperty({
    description: 'Current version of the Purchase Order for optimistic concurrency control',
    example: 1,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiPropertyOptional({ description: 'Updated supplier UUID', example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  @IsUUID()
  @IsOptional()
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Updated 3-character transaction currency code', example: 'VND' })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-character alphabetic code' })
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ description: 'Updated order date in YYYY-MM-DD format', example: '2026-10-05' })
  @IsDateString()
  @IsOptional()
  orderDate?: string;

  @ApiPropertyOptional({ description: 'Updated expected delivery date in YYYY-MM-DD format; null clears it', example: '2026-10-20', nullable: true })
  @IsDateString()
  @IsOptional()
  expectedDeliveryDate?: string | null;

  @ApiPropertyOptional({
    description: 'Updated line items (replaces all existing line items)',
    type: [CreatePurchaseOrderItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  @IsOptional()
  items?: CreatePurchaseOrderItemDto[];
}
