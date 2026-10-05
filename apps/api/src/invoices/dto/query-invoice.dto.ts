import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { INVOICE_STATUSES } from '../interfaces/invoice.interface';

export class QueryInvoiceDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000)
  page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 20;
  @ApiPropertyOptional({ enum: INVOICE_STATUSES })
  @IsOptional() @IsIn(INVOICE_STATUSES)
  status?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  supplierId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  purchaseOrderId?: string;
  @ApiPropertyOptional({ description: 'Exact original invoice number' })
  @IsOptional() @IsString() @MaxLength(100)
  invoiceNumber?: string;
}
