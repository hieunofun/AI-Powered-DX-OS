import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsDateString,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateGoodsReceiptItemDto } from './create-goods-receipt.dto';

export class UpdateGoodsReceiptDto {
  @ApiPropertyOptional({
    description: 'Updated physical receipt timestamp (ISO 8601)',
    example: '2026-10-04T12:00:00.000Z',
  })
  @IsDateString()
  @IsOptional()
  receivedAt?: string;

  @ApiPropertyOptional({
    description: 'Updated warehouse receiving reference or delivery note code',
    example: 'Updated BL-987654 delivery by FedEx',
  })
  @IsString()
  @IsOptional()
  referenceNote?: string;

  @ApiPropertyOptional({
    description: 'Updated list of line items (replaces all items on DRAFT GRN)',
    type: [CreateGoodsReceiptItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateGoodsReceiptItemDto)
  @IsOptional()
  items?: CreateGoodsReceiptItemDto[];
}
