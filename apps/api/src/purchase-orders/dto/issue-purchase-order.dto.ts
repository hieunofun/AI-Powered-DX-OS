import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class IssuePurchaseOrderDto {
  @ApiProperty({
    description: 'Current version of the Purchase Order for optimistic concurrency control',
    example: 1,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion: number;
}
