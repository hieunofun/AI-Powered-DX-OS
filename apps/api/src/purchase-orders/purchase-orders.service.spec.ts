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
    subtotal: 1000,
    taxAmount: 100,
    totalAmount: 1100,
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
        orderedQuantity: 10,
        unitPrice: 100,
        taxRate: 0.1,
        lineSubtotal: 1000,
        taxAmount: 100,
        lineTotal: 1100,
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
        { provide: PurchaseOrdersRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<PurchaseOrdersService>(PurchaseOrdersService);
    repository = module.get(PurchaseOrdersRepository);
  });

  describe('create', () => {
    it('creates a new Purchase Order when supplier is active and items are valid', async () => {
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);
      repository.createPO.mockResolvedValue(mockDraftPO as any);

      const result = await service.create(
        {
          supplierId: mockActiveSupplier.id,
          currency: 'VND',
          orderDate: '2026-10-04',
          expectedDeliveryDate: '2026-10-20',
          items: [
            {
              sku: 'ITEM-1',
              description: 'Test Item',
              orderedQuantity: 10,
              unitPrice: 100,
              taxRate: 0.1,
            },
          ],
        },
        mockUser,
      );

      expect(result).toBeDefined();
      expect(result.poNumber).toBe('PO-2026-000001');
      expect(repository.createPO).toHaveBeenCalled();
    });

    it('throws BadRequestException when supplier does not exist', async () => {
      repository.getSupplier.mockResolvedValue(null);

      await expect(
        service.create(
          {
            supplierId: 'non-existent-uuid',
            currency: 'VND',
            orderDate: '2026-10-04',
            items: [{ description: 'Test', orderedQuantity: 1, unitPrice: 10 }],
          },
          mockUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when supplier is not active', async () => {
      repository.getSupplier.mockResolvedValue(mockInactiveSupplier);

      await expect(
        service.create(
          {
            supplierId: mockInactiveSupplier.id,
            currency: 'VND',
            orderDate: '2026-10-04',
            items: [{ description: 'Test', orderedQuantity: 1, unitPrice: 10 }],
          },
          mockUser,
        ),
      ).rejects.toThrow(/not active/);
    });

    it('throws BadRequestException when items array is empty', async () => {
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);

      await expect(
        service.create(
          {
            supplierId: mockActiveSupplier.id,
            currency: 'VND',
            orderDate: '2026-10-04',
            items: [],
          },
          mockUser,
        ),
      ).rejects.toThrow(/at least one line item/);
    });
  });

  describe('update', () => {
    it('updates a DRAFT Purchase Order successfully', async () => {
      repository.findById.mockResolvedValue(mockDraftPO as any);
      const updatedPO = { ...mockDraftPO, version: 2 };
      repository.updateDraftPO.mockResolvedValue(updatedPO as any);

      const result = await service.update(
        mockDraftPO.id,
        {
          expectedVersion: 1,
          orderDate: '2026-10-05',
        },
        mockUser,
      );

      expect(result.version).toBe(2);
      expect(repository.updateDraftPO).toHaveBeenCalledWith(
        mockDraftPO.id,
        1,
        expect.objectContaining({ orderDate: '2026-10-05' }),
        undefined,
        expect.objectContaining({ subject: mockUser.sub }),
      );
    });

    it('throws ConflictException when updating an order not in DRAFT', async () => {
      repository.findById.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.ISSUED,
      } as any);

      await expect(
        service.update(
          mockDraftPO.id,
          { expectedVersion: 1, orderDate: '2026-10-05' },
          mockUser,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when expectedVersion does not match current version', async () => {
      repository.findById.mockResolvedValue(mockDraftPO as any);
      repository.updateDraftPO.mockRejectedValue(
        new ConflictException('Optimistic lock conflict'),
      );

      await expect(
        service.update(
          mockDraftPO.id,
          { expectedVersion: 99, orderDate: '2026-10-05' },
          mockUser,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('issue', () => {
    it('issues a DRAFT Purchase Order transitioning to ISSUED', async () => {
      repository.findById.mockResolvedValue(mockDraftPO as any);
      repository.getSupplier.mockResolvedValue(mockActiveSupplier);
      repository.issuePO.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.ISSUED,
        version: 2,
      } as any);

      const result = await service.issue(mockDraftPO.id, { expectedVersion: 1 }, mockUser);
      expect(result.status).toBe(PurchaseOrderStatus.ISSUED);
      expect(result.version).toBe(2);
    });

    it('throws ConflictException when issuing an order not in DRAFT', async () => {
      repository.findById.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.ISSUED,
      } as any);

      await expect(
        service.issue(mockDraftPO.id, { expectedVersion: 1 }, mockUser),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('cancel', () => {
    it('cancels a DRAFT Purchase Order with mandatory reason', async () => {
      repository.findById.mockResolvedValue(mockDraftPO as any);
      repository.cancelPO.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.CANCELLED,
        cancelledReason: 'Specifications revised',
        version: 2,
      } as any);

      const result = await service.cancel(
        mockDraftPO.id,
        { expectedVersion: 1, reason: 'Specifications revised' },
        mockUser,
      );

      expect(result.status).toBe(PurchaseOrderStatus.CANCELLED);
      expect(result.cancelledReason).toBe('Specifications revised');
    });

    it('throws BadRequestException when cancellation reason is blank', async () => {
      repository.findById.mockResolvedValue(mockDraftPO as any);

      await expect(
        service.cancel(
          mockDraftPO.id,
          { expectedVersion: 1, reason: '   ' },
          mockUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when trying to cancel a CLOSED order', async () => {
      repository.findById.mockResolvedValue({
        ...mockDraftPO,
        status: PurchaseOrderStatus.CLOSED,
      } as any);

      await expect(
        service.cancel(
          mockDraftPO.id,
          { expectedVersion: 1, reason: 'Too late' },
          mockUser,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });
});
