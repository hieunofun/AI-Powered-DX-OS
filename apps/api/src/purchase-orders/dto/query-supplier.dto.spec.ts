import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QuerySupplierDto } from './query-supplier.dto';
import { UpdatePurchaseOrderDto } from './update-purchase-order.dto';

describe('Procurement workspace DTOs', () => {
  it.each([{ page: '0' }, { limit: '101' }, { id: 'not-a-uuid' }, { search: 'x'.repeat(256) }])('rejects invalid lookup %j', async input => {
    expect((await validate(plainToInstance(QuerySupplierDto, input))).length).toBeGreaterThan(0);
  });
  it('transforms bounded pagination and permits resolving an inactive supplier by UUID', async () => {
    const query = plainToInstance(QuerySupplierDto, { page: '2', limit: '20', id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' });
    expect(await validate(query)).toHaveLength(0);
    expect(query.page).toBe(2);
  });
  it('explicitly permits clearing an optional expected delivery date', async () => {
    expect(await validate(plainToInstance(UpdatePurchaseOrderDto, { expectedVersion: 1, expectedDeliveryDate: null }))).toHaveLength(0);
  });
});
