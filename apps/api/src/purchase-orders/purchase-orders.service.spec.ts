import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersRepository } from './purchase-orders.repository';
import { PurchaseOrderStatus } from './domain/po-state-machine';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

describe('PurchaseOrdersService', () => {
  let service: PurchaseOrdersService;
  let repository: jest.Mocked<PurchaseOrdersRepository>;

  const mockUser: AuthenticatedUser = {
    sub: 'user-sub-123',
    username: 'buyer.demo',
    email: 'buyer@smartprocure.local',
    roles: ['buyer'],
  };

  const mockActiveSupplier = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    name: 'Active Tech Solutions',
    status: 'ACTIVE',
  };

  const mockInactiveSupplier = {
    id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    name: 'Dormant Vendor',
    status: 'INACTIVE',
  };

  const mockDraftPO = {
    id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    poNumber: 'PO-2026-000001',
    supplierId: mockActiveSupplier.id,
    currency: 'VND',
    status: PurchaseOrderStatus.DRAFT,
    orderDate: '2026-10-04',
    expectedDeliveryDate: '2026-10-20',
    subtotal: '1000.00',
    taxAmount: '100.00',
    totalAmount: '1100.00',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
        purchaseOrderId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        lineNumber: 1,
        sku: 'ITEM-1',
        description: 'Test Item',
        orderedQuantity: '10',
        unitPrice: '100.00',
        taxRate: '0.10',
        lineSubtotal: '1000.00',
        taxAmount: '100.00',
        lineTotal: '1100.00',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };

  beforeEach(async () => {
    const mockRepo: Partial<jest.Mocked<PurchaseOrdersRepository>> = {
      getSupplier: jest.fn(),
      generatePoNumber: jest.fn().mockResolvedValue('PO-2026-000001'),
      createPO: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn(),
      updateDraftPO: jest.fn(),
      issuePO: jest.fn(),
      cancelPO: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        {
          provide: PurchaseOrdersRepository,
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<PurchaseOrdersService>(PurchaseOrdersService);
    repository = module.get(PurchaseOrdersRepository);
  });

  describe('create', () => {
    const validDto = {
      supplierId: mockActiveSupplier.id,
      currency: 'vnd',
      orderDate: '2026-10-04',
      expectedDeliveryDate: '2026-10-15',
      items: [
        {
          sku: 'ITM-1',
          description: 'High Precision Sensor',
          orderedQuantity: '10',
          unitPrice: '150.50',
          taxRate: '0.10',
        },
      ],
    };

    it('creates a PO successfully with active supplier and server-calculated totals', async () => {
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);
      repository.createPO.mockResolvedValue(mockDraftPO);

      const result = await service.create(validDto, mockUser);

      expect(repository.getSupplier).toHaveBeenCalledWith(mockActiveSupplier.id);
      expect(repository.generatePoNumber).toHaveBeenCalled();
      expect(repository.createPO).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'VND', // uppercase normalized
          subtotal: '1505.00',
          taxAmount: '150.50',
          totalAmount: '1655.50',
        }),
        expect.arrayContaining([
          expect.objectContaining({
            lineSubtotal: '1505.00',
            taxAmount: '150.50',
            lineTotal: '1655.50',
          }),
        ]),
        { subject: mockUser.sub, roles: mockUser.roles },
      );
      expect(result).toEqual(mockDraftPO);
    });

    it('throws BadRequestException if supplier does not exist', async () => {
      repository.getSupplier.mockResolvedValue(null);

      await expect(service.create(validDto, mockUser)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if supplier is INACTIVE', async () => {
      repository.getSupplier.mockResolvedValue(mockInactiveSupplier);

      await expect(service.create(validDto, mockUser)).rejects.toThrow(
        /is not active/,
      );
    });

    it('throws BadRequestException if expectedDeliveryDate is earlier than orderDate', async () => {
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);

      await expect(
        service.create(
          {
            ...validDto,
            orderDate: '2026-10-10',
            expectedDeliveryDate: '2026-10-05',
          },
          mockUser,
        ),
      ).rejects.toThrow(/cannot be earlier than orderDate/);
    });

    it('throws BadRequestException if items array is empty', async () => {
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);

      await expect(service.create({ ...validDto, items: [] }, mockUser)).rejects.toThrow(
        /must contain at least one line item/,
      );
    });
  });

  describe('update', () => {
    it('updates a DRAFT PO successfully', async () => {
      repository.findById.mockResolvedValue(mockDraftPO);
      repository.updateDraftPO.mockResolvedValue({
        ...mockDraftPO,
        currency: 'USD',
        version: 2,
      });

      const result = await service.update(
        mockDraftPO.id,
        { expectedVersion: 1, currency: 'usd' },
        mockUser,
      );

      expect(repository.updateDraftPO).toHaveBeenCalledWith(
        mockDraftPO.id,
        1,
        expect.objectContaining({ currency: 'USD' }),
        undefined,
        { subject: mockUser.sub, roles: mockUser.roles },
      );
      expect(result.version).toBe(2);
    });

    it('throws ConflictException if attempting to update non-DRAFT PO', async () => {
      repository.findById.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.ISSUED,
      });

      await expect(
        service.update(mockDraftPO.id, { expectedVersion: 1, currency: 'USD' }, mockUser),
      ).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException if updating with inactive supplier', async () => {
      repository.findById.mockResolvedValue(mockDraftPO);
      repository.getSupplier.mockResolvedValue(mockInactiveSupplier);

      await expect(
        service.update(
          mockDraftPO.id,
          { expectedVersion: 1, supplierId: mockInactiveSupplier.id },
          mockUser,
        ),
      ).rejects.toThrow(/is inactive/);
    });

    it('throws BadRequestException if updated expectedDeliveryDate < orderDate', async () => {
      repository.findById.mockResolvedValue(mockDraftPO);

      await expect(
        service.update(
          mockDraftPO.id,
          { expectedVersion: 1, expectedDeliveryDate: '2026-10-01' },
          mockUser,
        ),
      ).rejects.toThrow(/cannot be earlier than orderDate/);
    });
  });

  describe('issue', () => {
    it('issues a DRAFT PO when supplier is ACTIVE, items exist, and totals reconcile', async () => {
      repository.findById.mockResolvedValue(mockDraftPO);
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);
      repository.issuePO.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.ISSUED,
        version: 2,
      });

      const result = await service.issue(mockDraftPO.id, { expectedVersion: 1 }, mockUser);

      expect(repository.issuePO).toHaveBeenCalledWith(mockDraftPO.id, 1, {
        subject: mockUser.sub,
        roles: mockUser.roles,
      });
      expect(result.status).toBe(PurchaseOrderStatus.ISSUED);
    });

    it('throws ConflictException if stored totals do not reconcile with item-derived totals', async () => {
      // Mock PO with manipulated/corrupted stored subtotal
      const corruptedPO = {
        ...mockDraftPO,
        subtotal: '9999.00', // Does not equal 10 * 100 = 1000.00
      };
      repository.findById.mockResolvedValue(corruptedPO);
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);

      await expect(
        service.issue(mockDraftPO.id, { expectedVersion: 1 }, mockUser),
      ).rejects.toThrow(ConflictException);
      expect(repository.issuePO).not.toHaveBeenCalled();
    });

    it('throws ConflictException if PO is not in DRAFT', async () => {
      repository.findById.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.ISSUED,
      });

      await expect(
        service.issue(mockDraftPO.id, { expectedVersion: 1 }, mockUser),
      ).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException if supplier became INACTIVE before issue', async () => {
      repository.findById.mockResolvedValue(mockDraftPO);
      repository.getSupplier.mockResolvedValue(mockInactiveSupplier);

      await expect(
        service.issue(mockDraftPO.id, { expectedVersion: 1 }, mockUser),
      ).rejects.toThrow(/not active/);
    });
  });

  describe('cancel', () => {
    it('cancels a DRAFT or ISSUED PO with non-blank reason', async () => {
      repository.findById.mockResolvedValue(mockDraftPO);
      repository.cancelPO.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.CANCELLED,
        version: 2,
      });

      const result = await service.cancel(
        mockDraftPO.id,
        { expectedVersion: 1, reason: '  Vendor could not meet schedule  ' },
        mockUser,
      );

      expect(repository.cancelPO).toHaveBeenCalledWith(
        mockDraftPO.id,
        1,
        'Vendor could not meet schedule', // trimmed
        { subject: mockUser.sub, roles: mockUser.roles },
      );
      expect(result.status).toBe(PurchaseOrderStatus.CANCELLED);
    });

    it('throws BadRequestException if cancellation reason is blank', async () => {
      repository.findById.mockResolvedValue(mockDraftPO);

      await expect(
        service.cancel(mockDraftPO.id, { expectedVersion: 1, reason: '   ' }, mockUser),
      ).rejects.toThrow(/cannot be blank/);
    });

    it('throws ConflictException if attempting to cancel a CLOSED PO', async () => {
      repository.findById.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.CLOSED,
      });

      await expect(
        service.cancel(mockDraftPO.id, { expectedVersion: 1, reason: 'Late delivery' }, mockUser),
      ).rejects.toThrow(ConflictException);
    });
  });
});
