import { ApiProperty } from '@nestjs/swagger';
import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';
import { Transform } from 'class-transformer';
import Decimal from 'decimal.js';

export function StrictPolicyTolerance() {
  return Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (raw === undefined || raw === null) return raw;
    if (typeof raw !== 'string') {
      return Symbol.for('INVALID_NON_STRING_DECIMAL');
    }
    return raw;
  });
}

export function IsStrictTolerancePercent(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrictTolerancePercent',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (typeof value !== 'string') return false;
          if (!/^\d+(\.\d+)?$/.test(value)) return false;

          const [intPart, fracPart] = value.split('.');
          if (fracPart !== undefined && fracPart.length > 2) return false;

          const strippedInt = intPart.replace(/^0+/, '') || '0';
          if (strippedInt !== '0' && strippedInt.length > 3) return false;

          try {
            const d = new Decimal(value);
            if (d.isNaN()) return false;
            return d.gte(0) && d.lte(100);
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid decimal string between 0.00 and 100.00 with max 2 decimal places fitting NUMERIC(5,2)`;
        },
      },
    });
  };
}

export class UpdateGoodsReceiptPolicyDto {
  @ApiProperty({
    description: 'Warehouse over-delivery tolerance percentage NUMERIC(5,2) (0.00 to 100.00)',
    example: '10.00',
    type: String,
  })
  @StrictPolicyTolerance()
  @IsStrictTolerancePercent()
  overDeliveryTolerancePercent: string;
}
