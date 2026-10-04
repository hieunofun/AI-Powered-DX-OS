import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { AuthService } from '../auth/auth.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { IssuePurchaseOrderDto } from './dto/issue-purchase-order.dto';
import { CancelPurchaseOrderDto } from './dto/cancel-purchase-order.dto';
import { QueryPurchaseOrderDto } from './dto/query-purchase-order.dto';
import { PurchaseOrderStatus } from './domain/po-state-machine';

describe('PurchaseOrdersController', () => {
  let controller: PurchaseOrdersController;

  const mockUser = {
    sub: 'sub-buyer-1234',
    username: 'buyer.demo',
    email: 'buyer.demo@smartprocure.local',
    roles: ['buyer'],
  };

  const mockPo = {
    id: 'po-uuid-1',
    poNumber: 'PO-2026-000001',
    supplierId: 'sup-1',
    currency: 'USD',
    status: PurchaseOrderStatus.DRAFT,
    orderDate: '2026-10-04',
    expectedDeliveryDate: '2026-10-15',
    subtotal: 1000,
    taxAmount: 100,
    totalAmount: 1100,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
  };

  const mockService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    issue: jest.fn(),
    cancel: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PurchaseOrdersController],
      providers: [
        {
          provide: PurchaseOrdersService,
          useValue: mockService,
        },
        {
          provide: AuthService,
          useValue: { verifyToken: jest.fn() },
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<PurchaseOrdersController>(PurchaseOrdersController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should call service.create with input and user', async () => {
      const dto: CreatePurchaseOrderDto = {
        supplierId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        currency: 'USD',
        orderDate: '2026-10-04',
        items: [
          {
            description: 'Item 1',
            orderedQuantity: 10,
            unitPrice: 100,
            taxRate: 0.1,
          },
        ],
      };
      mockService.create.mockResolvedValue(mockPo);

      const result = await controller.create(dto, mockUser);

      expect(mockService.create).toHaveBeenCalledWith(dto, mockUser);
      expect(result).toEqual(mockPo);
    });
  });

  describe('findAll', () => {
    it('should call service.findAll with query parameters', async () => {
      const queryDto: QueryPurchaseOrderDto = {
        page: 1,
        limit: 20,
        status: PurchaseOrderStatus.DRAFT,
      };
      const paginatedResult = {
        data: [mockPo],
        page: 1,
        limit: 20,
        total: 1,
      };
      mockService.findAll.mockResolvedValue(paginatedResult);

      const result = await controller.findAll(queryDto);

      expect(mockService.findAll).toHaveBeenCalledWith(queryDto);
      expect(result).toEqual(paginatedResult);
    });
  });

  describe('findOne', () => {
    it('should call service.findById with id', async () => {
      mockService.findById.mockResolvedValue(mockPo);

      const result = await controller.findOne('po-uuid-1');

      expect(mockService.findById).toHaveBeenCalledWith('po-uuid-1');
      expect(result).toEqual(mockPo);
    });
  });

  describe('update', () => {
    it('should call service.update with id, dto, and user', async () => {
      const dto: UpdatePurchaseOrderDto = {
        expectedVersion: 1,
        currency: 'EUR',
      };
      const updatedPo = { ...mockPo, currency: 'EUR', version: 2 };
      mockService.update.mockResolvedValue(updatedPo);

      const result = await controller.update('po-uuid-1', dto, mockUser);

      expect(mockService.update).toHaveBeenCalledWith('po-uuid-1', dto, mockUser);
      expect(result).toEqual(updatedPo);
    });
  });

  describe('issue', () => {
    it('should call service.issue with id, dto, and user', async () => {
      const dto: IssuePurchaseOrderDto = { expectedVersion: 1 };
      const issuedPo = { ...mockPo, status: PurchaseOrderStatus.ISSUED, version: 2 };
      mockService.issue.mockResolvedValue(issuedPo);

      const result = await controller.issue('po-uuid-1', dto, mockUser);

      expect(mockService.issue).toHaveBeenCalledWith('po-uuid-1', dto, mockUser);
      expect(result).toEqual(issuedPo);
    });
  });

  describe('cancel', () => {
    it('should call service.cancel with id, dto, and user', async () => {
      const dto: CancelPurchaseOrderDto = {
        expectedVersion: 1,
        reason: 'Duplicate requisition',
      };
      const cancelledPo = {
        ...mockPo,
        status: PurchaseOrderStatus.CANCELLED,
        cancelledReason: 'Duplicate requisition',
        version: 2,
      };
      mockService.cancel.mockResolvedValue(cancelledPo);

      const result = await controller.cancel('po-uuid-1', dto, mockUser);

      expect(mockService.cancel).toHaveBeenCalledWith('po-uuid-1', dto, mockUser);
      expect(result).toEqual(cancelledPo);
    });
  });
});
