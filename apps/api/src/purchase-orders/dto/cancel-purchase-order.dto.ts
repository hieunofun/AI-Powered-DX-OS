import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min, IsString, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';

export class CancelPurchaseOrderDto {
  @ApiProperty({
    description: 'Current version of the Purchase Order for optimistic concurrency control',
    example: 1,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiProperty({
    description: 'Justification for cancelling the Purchase Order (trimmed non-empty string)',
    example: 'Vendor unable to meet delivery lead time specifications',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Cancellation reason is required and cannot be blank' })
  reason: string;
}
