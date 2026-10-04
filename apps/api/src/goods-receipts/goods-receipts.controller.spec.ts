import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { GoodsReceiptsController } from './goods-receipts.controller';
import { GoodsReceiptsService } from './goods-receipts.service';
import { AuthService } from '../auth/auth.service';
import { CreateGoodsReceiptDto } from './dto/create-goods-receipt.dto';
import { UpdateGoodsReceiptDto } from './dto/update-goods-receipt.dto';
import { CancelGoodsReceiptDto } from './dto/cancel-goods-receipt.dto';
import { QueryGoodsReceiptDto } from './dto/query-goods-receipt.dto';
import { UpdateGoodsReceiptPolicyDto } from './dto/update-policy.dto';
import { GrnStatus } from './domain/grn-state-machine';
import { PurchaseOrderStatus } from '../purchase-orders/domain/po-state-machine';

describe('GoodsReceiptsController', () => {
  let controller: GoodsReceiptsController;

  const mockUser = {
    sub: 'sub-warehouse-1234',
    username: 'warehouse.demo',
    email: 'warehouse.demo@smartprocure.local',
    roles: ['warehouse'],
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

  const mockService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    receive: jest.fn(),
    cancel: jest.fn(),
    getActivePolicy: jest.fn(),
    updateActivePolicy: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GoodsReceiptsController],
      providers: [
        {
          provide: GoodsReceiptsService,
          useValue: mockService,
        },
        {
          provide: AuthService,
          useValue: { verifyToken: jest.fn() },
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<GoodsReceiptsController>(GoodsReceiptsController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should delegate create to service with authenticated user', async () => {
      const dto: CreateGoodsReceiptDto = {
        purchaseOrderId: 'po-uuid-1',
        items: [
          {
            purchaseOrderItemId: 'po-item-1',
            receivedQuantity: '10.0000',
            acceptedQuantity: '10.0000',
            rejectedQuantity: '0.0000',
          },
        ],
      };
      mockService.create.mockResolvedValue(mockGrn);

      const result = await controller.create(dto, mockUser);
      expect(mockService.create).toHaveBeenCalledWith(dto, mockUser);
      expect(result).toEqual(mockGrn);
    });
  });

  describe('findAll', () => {
    it('should call service.findAll with query parameters', async () => {
      const query: QueryGoodsReceiptDto = { page: 1, limit: 10 };
      const paginated = { data: [mockGrn], page: 1, limit: 10, total: 1 };
      mockService.findAll.mockResolvedValue(paginated);

      const result = await controller.findAll(query);
      expect(mockService.findAll).toHaveBeenCalledWith(query);
      expect(result).toEqual(paginated);
    });
  });

  describe('findById', () => {
    it('should call service.findById with parsed UUID', async () => {
      mockService.findById.mockResolvedValue(mockGrn);

      const result = await controller.findById('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
      expect(mockService.findById).toHaveBeenCalledWith('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
      expect(result).toEqual(mockGrn);
    });
  });

  describe('update', () => {
    it('should call service.update with id, dto, and user', async () => {
      const dto: UpdateGoodsReceiptDto = { referenceNote: 'Updated' };
      mockService.update.mockResolvedValue({ ...mockGrn, referenceNote: 'Updated' });

      const result = await controller.update(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        dto,
        mockUser,
      );
      expect(mockService.update).toHaveBeenCalledWith(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        dto,
        mockUser,
      );
      expect(result.referenceNote).toBe('Updated');
    });
  });

  describe('receive', () => {
    it('should call service.receive to finalize inspection', async () => {
      const response = {
        grn: { ...mockGrn, status: GrnStatus.RECEIVED },
        poStatus: PurchaseOrderStatus.FULLY_RECEIVED,
        poVersion: 2,
      };
      mockService.receive.mockResolvedValue(response);

      const result = await controller.receive('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', mockUser);
      expect(mockService.receive).toHaveBeenCalledWith(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        mockUser,
      );
      expect(result).toEqual(response);
    });
  });

  describe('cancel', () => {
    it('should call service.cancel with id, dto, and user', async () => {
      const dto: CancelGoodsReceiptDto = { reason: 'Wrong goods delivered' };
      const response = {
        grn: { ...mockGrn, status: GrnStatus.CANCELLED },
        poStatus: PurchaseOrderStatus.ISSUED,
        poVersion: 3,
      };
      mockService.cancel.mockResolvedValue(response);

      const result = await controller.cancel(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        dto,
        mockUser,
      );
      expect(mockService.cancel).toHaveBeenCalledWith(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        dto,
        mockUser,
      );
      expect(result).toEqual(response);
    });
  });

  describe('Policy endpoints', () => {
    it('should call service.getActivePolicy on GET /policy', async () => {
      const policy = {
        id: 'pol-1',
        policyCode: 'DEFAULT',
        overDeliveryTolerancePercent: '0.00',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockService.getActivePolicy.mockResolvedValue(policy);

      const result = await controller.getPolicy();
      expect(mockService.getActivePolicy).toHaveBeenCalled();
      expect(result).toEqual(policy);
    });

    it('should call service.updateActivePolicy on PATCH /policy', async () => {
      const dto: UpdateGoodsReceiptPolicyDto = { overDeliveryTolerancePercent: '10.00' };
      const updatedPolicy = {
        id: 'pol-1',
        policyCode: 'DEFAULT',
        overDeliveryTolerancePercent: '10.00',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockService.updateActivePolicy.mockResolvedValue(updatedPolicy);

      const result = await controller.updatePolicy(dto, mockUser);
      expect(mockService.updateActivePolicy).toHaveBeenCalledWith(dto, mockUser);
      expect(result).toEqual(updatedPolicy);
    });
  });
});
