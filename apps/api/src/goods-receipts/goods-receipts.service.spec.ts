import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { GoodsReceiptsService } from './goods-receipts.service';
import { GoodsReceiptsRepository } from './goods-receipts.repository';
import { GrnStatus } from './domain/grn-state-machine';
import { PurchaseOrderStatus } from '../purchase-orders/domain/po-state-machine';

describe('GoodsReceiptsService', () => {
  let service: GoodsReceiptsService;

  const mockUser = {
    sub: 'sub-warehouse-1234',
    roles: ['warehouse'],
  };

  const mockPo = {
    id: 'po-uuid-1',
    poNumber: 'PO-2026-000001',
    status: PurchaseOrderStatus.ISSUED,
    version: 1,
    items: [
      { id: 'item-1', lineNumber: 1, orderedQuantity: '100.0000', description: 'Item 1' },
      { id: 'item-2', lineNumber: 2, orderedQuantity: '50.0000', description: 'Item 2' },
    ],
  };

  const mockGrn = {
    id: 'grn-uuid-1',
    grnNumber: 'GRN-2026-000001',
    purchaseOrderId: 'po-uuid-1',
    receivedAt: '2026-10-04T10:00:00.000Z',
    status: GrnStatus.DRAFT,
    referenceNote: 'Ref-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
  };

  const mockRepository = {
    generateGrnNumber: jest.fn(),
    getActivePolicy: jest.fn(),
    updateActivePolicy: jest.fn(),
    getPurchaseOrder: jest.fn(),
    createGRN: jest.fn(),
    findById: jest.fn(),
    updateDraftGRN: jest.fn(),
    receiveGRN: jest.fn(),
    cancelGRN: jest.fn(),
    findAll: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoodsReceiptsService,
        {
          provide: GoodsReceiptsRepository,
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<GoodsReceiptsService>(GoodsReceiptsService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates a new Goods Receipt in DRAFT status when PO is ISSUED', async () => {
      mockRepository.getPurchaseOrder.mockResolvedValue(mockPo);
      mockRepository.generateGrnNumber.mockResolvedValue('GRN-2026-000001');
      mockRepository.createGRN.mockResolvedValue(mockGrn);

      const result = await service.create(
        {
          purchaseOrderId: 'po-uuid-1',
          items: [
            {
              purchaseOrderItemId: 'item-1',
              lotNumber: 'LOT-A',
              receivedQuantity: '60.0000',
              acceptedQuantity: '60.0000',
              rejectedQuantity: '0.0000',
            },
          ],
        },
        mockUser,
      );

      expect(mockRepository.createGRN).toHaveBeenCalled();
      expect(result).toEqual(mockGrn);
    });

    it('creates a new Goods Receipt when PO is PARTIALLY_RECEIVED', async () => {
      mockRepository.getPurchaseOrder.mockResolvedValue({
        ...mockPo,
        status: PurchaseOrderStatus.PARTIALLY_RECEIVED,
      });
      mockRepository.generateGrnNumber.mockResolvedValue('GRN-2026-000002');
      mockRepository.createGRN.mockResolvedValue(mockGrn);

      const result = await service.create(
        {
          purchaseOrderId: 'po-uuid-1',
          items: [
            {
              purchaseOrderItemId: 'item-1',
              receivedQuantity: '40.0000',
              acceptedQuantity: '40.0000',
              rejectedQuantity: '0.0000',
            },
          ],
        },
        mockUser,
      );

      expect(result).toEqual(mockGrn);
    });

    it('throws BadRequestException if parent PO does not exist', async () => {
      mockRepository.getPurchaseOrder.mockResolvedValue(null);

      await expect(
        service.create(
          {
            purchaseOrderId: 'po-non-existent',
            items: [],
          },
          mockUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if parent PO is in DRAFT or terminal status', async () => {
      mockRepository.getPurchaseOrder.mockResolvedValue({
        ...mockPo,
        status: PurchaseOrderStatus.DRAFT,
      });

      await expect(
        service.create(
          {
            purchaseOrderId: 'po-uuid-1',
            items: [],
          },
          mockUser,
        ),
      ).rejects.toThrow(/must be in 'ISSUED' or 'PARTIALLY_RECEIVED'/);

      mockRepository.getPurchaseOrder.mockResolvedValue({
        ...mockPo,
        status: PurchaseOrderStatus.FULLY_RECEIVED,
      });

      await expect(
        service.create(
          {
            purchaseOrderId: 'po-uuid-1',
            items: [],
          },
          mockUser,
        ),
      ).rejects.toThrow(/must be in 'ISSUED' or 'PARTIALLY_RECEIVED'/);
    });

    it('throws BadRequestException if GRN item does not belong to parent PO', async () => {
      mockRepository.getPurchaseOrder.mockResolvedValue(mockPo);

      await expect(
        service.create(
          {
            purchaseOrderId: 'po-uuid-1',
            items: [
              {
                purchaseOrderItemId: 'item-alien',
                receivedQuantity: '10.0000',
                acceptedQuantity: '10.0000',
                rejectedQuantity: '0.0000',
              },
            ],
          },
          mockUser,
        ),
      ).rejects.toThrow(/does not belong to parent PO/);
    });

    it('throws BadRequestException if rejectedQuantity > 0 without damageNote', async () => {
      mockRepository.getPurchaseOrder.mockResolvedValue(mockPo);

      await expect(
        service.create(
          {
            purchaseOrderId: 'po-uuid-1',
            items: [
              {
                purchaseOrderItemId: 'item-1',
                receivedQuantity: '10.0000',
                acceptedQuantity: '8.0000',
                rejectedQuantity: '2.0000',
                damageNote: '',
              },
            ],
          },
          mockUser,
        ),
      ).rejects.toThrow(/damageNote is mandatory/);
    });
  });

  describe('update', () => {
    it('updates a DRAFT GRN successfully', async () => {
      mockRepository.findById.mockResolvedValue(mockGrn);
      mockRepository.updateDraftGRN.mockResolvedValue({
        ...mockGrn,
        referenceNote: 'Updated',
      });

      const result = await service.update(
        'grn-uuid-1',
        { referenceNote: 'Updated' },
        mockUser,
      );

      expect(result.referenceNote).toBe('Updated');
    });

    it('throws ConflictException if attempting to edit non-DRAFT GRN', async () => {
      mockRepository.findById.mockResolvedValue({
        ...mockGrn,
        status: GrnStatus.RECEIVED,
      });

      await expect(
        service.update('grn-uuid-1', { referenceNote: 'Updated' }, mockUser),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('receive', () => {
    it('finalizes a DRAFT GRN and calls repository receiveGRN', async () => {
      mockRepository.findById.mockResolvedValue(mockGrn);
      mockRepository.receiveGRN.mockResolvedValue({
        grn: { ...mockGrn, status: GrnStatus.RECEIVED },
        poStatus: PurchaseOrderStatus.FULLY_RECEIVED,
        poVersion: 2,
      });

      const result = await service.receive('grn-uuid-1', mockUser);
      expect(result.grn.status).toBe(GrnStatus.RECEIVED);
      expect(result.poStatus).toBe(PurchaseOrderStatus.FULLY_RECEIVED);
    });

    it('throws ConflictException if GRN is already RECEIVED or CANCELLED', async () => {
      mockRepository.findById.mockResolvedValue({
        ...mockGrn,
        status: GrnStatus.RECEIVED,
      });

      await expect(service.receive('grn-uuid-1', mockUser)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('cancel', () => {
    it('cancels a GRN and returns cancellation result', async () => {
      mockRepository.findById.mockResolvedValue(mockGrn);
      mockRepository.cancelGRN.mockResolvedValue({
        grn: {
          ...mockGrn,
          status: GrnStatus.CANCELLED,
          cancelledReason: 'Vendor recalled batch',
        },
      });

      const result = await service.cancel(
        'grn-uuid-1',
        { reason: 'Vendor recalled batch' },
        mockUser,
      );

      expect(result.grn.status).toBe(GrnStatus.CANCELLED);
    });

    it('throws ConflictException if GRN is already CANCELLED', async () => {
      mockRepository.findById.mockResolvedValue({
        ...mockGrn,
        status: GrnStatus.CANCELLED,
      });

      await expect(
        service.cancel('grn-uuid-1', { reason: 'Retry cancel' }, mockUser),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('policy', () => {
    it('retrieves active policy from repository', async () => {
      const policy = {
        id: 'pol-1',
        policyCode: 'DEFAULT',
        overDeliveryTolerancePercent: '0.00',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockRepository.getActivePolicy.mockResolvedValue(policy);

      const result = await service.getActivePolicy();
      expect(result).toEqual(policy);
    });

    it('updates active policy tolerance', async () => {
      const updated = {
        id: 'pol-1',
        policyCode: 'DEFAULT',
        overDeliveryTolerancePercent: '5.00',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockRepository.updateActivePolicy.mockResolvedValue(updated);

      const result = await service.updateActivePolicy(
        { overDeliveryTolerancePercent: '5.00' },
        mockUser,
      );
      expect(result.overDeliveryTolerancePercent).toBe('5.00');
    });
  });
});
