import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { GrnStatus } from '../domain/grn-state-machine';

export class QueryGoodsReceiptDto {
  @ApiPropertyOptional({
    description: 'Filter by Purchase Order UUID',
    example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  })
  @IsUUID()
  @IsOptional()
  purchaseOrderId?: string;

  @ApiPropertyOptional({
    description: 'Filter by GRN lifecycle status',
    enum: GrnStatus,
    example: GrnStatus.RECEIVED,
  })
  @IsEnum(GrnStatus)
  @IsOptional()
  status?: GrnStatus;

  @ApiPropertyOptional({
    description: 'Filter by exact or partial GRN number',
    example: 'GRN-2026-000001',
  })
  @IsString()
  @IsOptional()
  grnNumber?: string;

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    example: 1,
    default: 1,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 20,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;
}
