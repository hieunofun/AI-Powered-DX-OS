import { ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { StrictPolicyTolerance, IsStrictTolerancePercent } from '../../goods-receipts/dto/update-policy.dto';
export class UpdateMatchingPolicyDto {
  @ApiPropertyOptional({ type: String, example: '0.00' })
  @StrictPolicyTolerance() @ValidateIf((_, value) => value !== undefined) @IsStrictTolerancePercent()
  quantityTolerancePercent?: string;
  @ApiPropertyOptional({ type: String, example: '1.00' })
  @StrictPolicyTolerance() @ValidateIf((_, value) => value !== undefined) @IsStrictTolerancePercent()
  priceTolerancePercent?: string;
  @ApiPropertyOptional({ type: String, example: '0.00' })
  @StrictPolicyTolerance() @ValidateIf((_, value) => value !== undefined) @IsStrictTolerancePercent()
  taxTolerancePercent?: string;
  @ApiPropertyOptional({ type: String, example: '0.00' })
  @StrictPolicyTolerance() @ValidateIf((_, value) => value !== undefined) @IsStrictTolerancePercent()
  totalTolerancePercent?: string;
}
