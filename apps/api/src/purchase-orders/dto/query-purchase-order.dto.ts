import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max, IsEnum, IsUUID, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseOrderStatus } from '../domain/po-state-machine';

export class QueryPurchaseOrderDto {
  @ApiPropertyOptional({ description: 'Page number (1-indexed)', example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Number of items per page (maximum 100)', example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Filter by Purchase Order lifecycle status', enum: PurchaseOrderStatus })
  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  @ApiPropertyOptional({ description: 'Filter by supplier UUID' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Filter by PO number (partial match supported)' })
  @IsOptional()
  @IsString()
  poNumber?: string;
}
