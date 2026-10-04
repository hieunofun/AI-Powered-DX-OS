import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';

export class CancelGoodsReceiptDto {
  @ApiProperty({
    description: 'Mandatory reason for cancelling the Goods Receipt',
    example: 'Damaged shipment returned to vendor in full',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'reason cannot be empty or whitespace only' })
  reason: string;
}
