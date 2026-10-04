import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePurchaseOrderDto, CreatePurchaseOrderItemDto } from './create-purchase-order.dto';

describe('CreatePurchaseOrderDto Validation (PostgreSQL Decimal Scale & Precision Boundaries)', () => {
  const transformAndValidateItem = async (plain: any) => {
    const instance = plainToInstance(
      CreatePurchaseOrderItemDto,
      plain,
      { enableImplicitConversion: true },
    );
    const errors = await validate(instance);
    return { instance, errors };
  };

  const transformAndValidateOrder = async (plain: any) => {
    const instance = plainToInstance(
      CreatePurchaseOrderDto,
      plain,
      { enableImplicitConversion: true },
    );
    const errors = await validate(instance);
    return { instance, errors };
  };

  describe('Scale boundaries (max 4 decimal places)', () => {
    it('accepts exact 4 decimal places "1.0049" for unitPrice and orderedQuantity', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Test Item',
        orderedQuantity: '1.0049',
        unitPrice: '1.0049',
        taxRate: '0.0825',
      });
      expect(errors.length).toBe(0);
    });

    it('rejects 5 decimal places "1.00495" for unitPrice with validation error', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Test Item',
        orderedQuantity: '1.0000',
        unitPrice: '1.00495',
        taxRate: '0.1000',
      });
      expect(errors.length).toBeGreaterThan(0);
      const unitPriceError = errors.find((e) => e.property === 'unitPrice');
      expect(unitPriceError).toBeDefined();
      expect(unitPriceError?.constraints?.isUnitPriceString).toContain('max 4 decimal places');
    });

    it('rejects 5 decimal places "2.12345" for orderedQuantity with validation error', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Test Item',
        orderedQuantity: '2.12345',
        unitPrice: '100.0000',
      });
      expect(errors.length).toBeGreaterThan(0);
      const qtyError = errors.find((e) => e.property === 'orderedQuantity');
      expect(qtyError).toBeDefined();
      expect(qtyError?.constraints?.isOrderedQuantityString).toContain('max 4 decimal places');
    });

    it('rejects 5 decimal places "0.08255" for taxRate with validation error', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Test Item',
        orderedQuantity: '1.0000',
        unitPrice: '100.0000',
        taxRate: '0.08255',
      });
      expect(errors.length).toBeGreaterThan(0);
      const taxError = errors.find((e) => e.property === 'taxRate');
      expect(taxError).toBeDefined();
      expect(taxError?.constraints?.isTaxRateString).toContain('max 4 decimal places');
    });
  });

  describe('Precision and range boundaries', () => {
    it('accepts values fitting NUMERIC(18,4) (up to 14 integer digits)', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Large Item',
        orderedQuantity: '99999999999999.9999',
        unitPrice: '99999999999999.9999',
      });
      expect(errors.length).toBe(0);
    });

    it('rejects values exceeding NUMERIC(18,4) (15 integer digits)', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Overflow Item',
        orderedQuantity: '100000000000000.0000',
        unitPrice: '100000000000000.0000',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'orderedQuantity')).toBeDefined();
      expect(errors.find((e) => e.property === 'unitPrice')).toBeDefined();
    });

    it('accepts taxRate fitting NUMERIC(7,4) (up to 3 integer digits: 999.9999)', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Luxury Tax Item',
        orderedQuantity: '1.0000',
        unitPrice: '100.0000',
        taxRate: '999.9999',
      });
      expect(errors.length).toBe(0);
    });

    it('rejects taxRate exceeding NUMERIC(7,4) (4 integer digits: 1000.0000)', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Overflow Tax Item',
        orderedQuantity: '1.0000',
        unitPrice: '100.0000',
        taxRate: '1000.0000',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'taxRate')).toBeDefined();
    });
  });

  describe('Strict string decimal requirement (rejects native JavaScript numbers)', () => {
    it('rejects native JavaScript number for orderedQuantity', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Number Item',
        orderedQuantity: 10,
        unitPrice: '100.0000',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'orderedQuantity')).toBeDefined();
    });

    it('rejects native JavaScript number for unitPrice', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Number Item',
        orderedQuantity: '10.0000',
        unitPrice: 150000,
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'unitPrice')).toBeDefined();
    });

    it('rejects native JavaScript number with excess scale (1.00495)', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Float Item',
        orderedQuantity: '1.0000',
        unitPrice: 1.00495,
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'unitPrice')).toBeDefined();
    });
  });

  describe('Sign and non-negativity rules', () => {
    it('rejects zero or negative orderedQuantity', async () => {
      const { errors: zeroErrors } = await transformAndValidateItem({
        description: 'Zero Qty',
        orderedQuantity: '0',
        unitPrice: '100.00',
      });
      expect(zeroErrors.find((e) => e.property === 'orderedQuantity')).toBeDefined();

      const { errors: negErrors } = await transformAndValidateItem({
        description: 'Negative Qty',
        orderedQuantity: '-5.0000',
        unitPrice: '100.00',
      });
      expect(negErrors.find((e) => e.property === 'orderedQuantity')).toBeDefined();
    });

    it('allows zero unitPrice and taxRate, but rejects negative values', async () => {
      const { errors: validZeroErrors } = await transformAndValidateItem({
        description: 'Zero Price',
        orderedQuantity: '1.0000',
        unitPrice: '0',
        taxRate: '0',
      });
      expect(validZeroErrors.length).toBe(0);

      const { errors: negPriceErrors } = await transformAndValidateItem({
        description: 'Neg Price',
        orderedQuantity: '1.0000',
        unitPrice: '-10.00',
      });
      expect(negPriceErrors.find((e) => e.property === 'unitPrice')).toBeDefined();

      const { errors: negTaxErrors } = await transformAndValidateItem({
        description: 'Neg Tax',
        orderedQuantity: '1.0000',
        unitPrice: '10.00',
        taxRate: '-0.05',
      });
      expect(negTaxErrors.find((e) => e.property === 'taxRate')).toBeDefined();
    });

    it('rejects malformed and non-numeric strings', async () => {
      const { errors } = await transformAndValidateItem({
        description: 'Bad Input',
        orderedQuantity: 'abc',
        unitPrice: '12.34.56',
        taxRate: '1e5',
      });
      expect(errors.find((e) => e.property === 'orderedQuantity')).toBeDefined();
      expect(errors.find((e) => e.property === 'unitPrice')).toBeDefined();
      expect(errors.find((e) => e.property === 'taxRate')).toBeDefined();
    });
  });

  describe('Complete Order DTO validation', () => {
    it('validates a valid order with decimal string items', async () => {
      const { errors } = await transformAndValidateOrder({
        supplierId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        currency: 'VND',
        orderDate: '2026-10-04',
        expectedDeliveryDate: '2026-10-18',
        items: [
          {
            description: 'Item 1',
            orderedQuantity: '1.0049',
            unitPrice: '1.0049',
            taxRate: '0.1000',
          },
        ],
      });
      expect(errors.length).toBe(0);
    });
  });
});
