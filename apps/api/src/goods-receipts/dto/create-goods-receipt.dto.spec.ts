import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateGoodsReceiptItemDto } from './create-goods-receipt.dto';
import { UpdateGoodsReceiptPolicyDto } from './update-policy.dto';

describe('Goods Receipt DTO Validation', () => {
  const transformAndValidateItem = async (plain: any) => {
    const instance = plainToInstance(
      CreateGoodsReceiptItemDto,
      plain,
      { enableImplicitConversion: true },
    );
    const errors = await validate(instance);
    return { instance, errors };
  };

  const transformAndValidatePolicy = async (plain: any) => {
    const instance = plainToInstance(
      UpdateGoodsReceiptPolicyDto,
      plain,
      { enableImplicitConversion: true },
    );
    const errors = await validate(instance);
    return { instance, errors };
  };

  describe('Item Quantity Scale & Boundaries', () => {
    it('accepts exact 4 decimal places for receivedQuantity, acceptedQuantity, rejectedQuantity', async () => {
      const { errors } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        lotNumber: 'LOT-123',
        receivedQuantity: '10.0049',
        acceptedQuantity: '8.0049',
        rejectedQuantity: '2.0000',
        damageNote: 'Minor defect',
      });
      expect(errors.length).toBe(0);
    });

    it('rejects 5 decimal places for receivedQuantity (10.00495)', async () => {
      const { errors } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        receivedQuantity: '10.00495',
        acceptedQuantity: '10.0000',
        rejectedQuantity: '0.0000',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'receivedQuantity')).toBeDefined();
    });

    it('rejects native JavaScript numbers for quantities', async () => {
      const { errors } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        receivedQuantity: 10,
        acceptedQuantity: '10.0000',
        rejectedQuantity: '0.0000',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'receivedQuantity')).toBeDefined();
    });

    it('rejects zero or negative receivedQuantity', async () => {
      const { errors: zeroErr } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        receivedQuantity: '0.0000',
        acceptedQuantity: '0.0000',
        rejectedQuantity: '0.0000',
      });
      expect(zeroErr.find((e) => e.property === 'receivedQuantity')).toBeDefined();

      const { errors: negErr } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        receivedQuantity: '-1.0000',
        acceptedQuantity: '0.0000',
        rejectedQuantity: '0.0000',
      });
      expect(negErr.find((e) => e.property === 'receivedQuantity')).toBeDefined();
    });

    it('rejects negative accepted or rejected quantities', async () => {
      const { errors: negAccepted } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        receivedQuantity: '10.0000',
        acceptedQuantity: '-5.0000',
        rejectedQuantity: '0.0000',
      });
      expect(negAccepted.find((e) => e.property === 'acceptedQuantity')).toBeDefined();

      const { errors: negRejected } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        receivedQuantity: '10.0000',
        acceptedQuantity: '10.0000',
        rejectedQuantity: '-1.0000',
      });
      expect(negRejected.find((e) => e.property === 'rejectedQuantity')).toBeDefined();
    });

    it('accepts optional lotNumber and verifies max length 100', async () => {
      const { errors: validLot } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        lotNumber: 'A'.repeat(100),
        receivedQuantity: '10.0000',
        acceptedQuantity: '10.0000',
        rejectedQuantity: '0.0000',
      });
      expect(validLot.length).toBe(0);

      const { errors: invalidLot } = await transformAndValidateItem({
        purchaseOrderItemId: 'c2b5bc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        lotNumber: 'A'.repeat(101),
        receivedQuantity: '10.0000',
        acceptedQuantity: '10.0000',
        rejectedQuantity: '0.0000',
      });
      expect(invalidLot.find((e) => e.property === 'lotNumber')).toBeDefined();
    });
  });

  describe('Policy DTO Validation', () => {
    it('accepts valid tolerance values between 0.00 and 100.00', async () => {
      const { errors: zeroErr } = await transformAndValidatePolicy({
        overDeliveryTolerancePercent: '0.00',
      });
      expect(zeroErr.length).toBe(0);

      const { errors: tenErr } = await transformAndValidatePolicy({
        overDeliveryTolerancePercent: '10.00',
      });
      expect(tenErr.length).toBe(0);

      const { errors: maxErr } = await transformAndValidatePolicy({
        overDeliveryTolerancePercent: '100.00',
      });
      expect(maxErr.length).toBe(0);
    });

    it('rejects tolerance > 100.00', async () => {
      const { errors } = await transformAndValidatePolicy({
        overDeliveryTolerancePercent: '100.01',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'overDeliveryTolerancePercent')).toBeDefined();
    });

    it('rejects negative tolerance', async () => {
      const { errors } = await transformAndValidatePolicy({
        overDeliveryTolerancePercent: '-1.00',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'overDeliveryTolerancePercent')).toBeDefined();
    });

    it('rejects excess scale > 2 decimal places for policy', async () => {
      const { errors } = await transformAndValidatePolicy({
        overDeliveryTolerancePercent: '10.005',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'overDeliveryTolerancePercent')).toBeDefined();
    });

    it('rejects native JavaScript numbers for policy tolerance', async () => {
      const { errors } = await transformAndValidatePolicy({
        overDeliveryTolerancePercent: 10,
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.find((e) => e.property === 'overDeliveryTolerancePercent')).toBeDefined();
    });
  });
});
