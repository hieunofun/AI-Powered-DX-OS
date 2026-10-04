import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, UnauthorizedException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import Decimal from 'decimal.js';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { GoodsReceiptsRepository } from '../src/goods-receipts/goods-receipts.repository';
import { GrnStatus } from '../src/goods-receipts/domain/grn-state-machine';
import { PurchaseOrderStatus } from '../src/purchase-orders/domain/po-state-machine';
import { GoodsReceiptEntity } from '../src/goods-receipts/interfaces/goods-receipt.interface';

describe('GoodsReceiptsController (e2e)', () => {
  let app: INestApplication;

  const mockWarehouse = {
    sub: 'sub-warehouse-1111',
    username: 'warehouse.demo',
    email: 'warehouse.demo@smartprocure.local',
    roles: ['warehouse'],
  };

  const mockAdmin = {
    sub: 'sub-admin-2222',
    username: 'admin.demo',
    email: 'admin.demo@smartprocure.local',
    roles: ['admin'],
  };

  const mockBuyer = {
    sub: 'sub-buyer-3333',
    username: 'buyer.demo',
    email: 'buyer.demo@smartprocure.local',
    roles: ['buyer'],
  };

  const mockAuthService = {
    verifyToken: jest.fn(async (token: string) => {
      if (token === 'warehouse-token') return mockWarehouse;
      if (token === 'admin-token') return mockAdmin;
      if (token === 'buyer-token') return mockBuyer;
      throw new UnauthorizedException('Invalid token');
    }),
  };

  const PO_ISSUED_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const PO_ITEM_1_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
  const PO_ITEM_2_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

  const PO_DRAFT_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';

  const poStore = new Map<string, any>([
    [
      PO_ISSUED_ID,
      {
        id: PO_ISSUED_ID,
        poNumber: 'PO-2026-000001',
        status: PurchaseOrderStatus.ISSUED,
        version: 1,
        items: [
          { id: PO_ITEM_1_ID, lineNumber: 1, orderedQuantity: '100.0000', description: 'Item 1' },
          { id: PO_ITEM_2_ID, lineNumber: 2, orderedQuantity: '50.0000', description: 'Item 2' },
        ],
      },
    ],
    [
      PO_DRAFT_ID,
      {
        id: PO_DRAFT_ID,
        poNumber: 'PO-2026-000002',
        status: PurchaseOrderStatus.DRAFT,
        version: 1,
        items: [],
      },
    ],
  ]);

  let currentPolicy = {
    id: 'pol-uuid-1',
    policyCode: 'DEFAULT',
    overDeliveryTolerancePercent: '0.00',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const grnStore = new Map<string, GoodsReceiptEntity>();
  let grnCounter = 1;

  const mockRepository = {
    generateGrnNumber: jest.fn(async () => {
      return `GRN-2026-${String(grnCounter++).padStart(6, '0')}`;
    }),

    getActivePolicy: jest.fn(async () => currentPolicy),

    updateActivePolicy: jest.fn(async (tolerance: string, _actor?: any) => {
      currentPolicy = {
        ...currentPolicy,
        overDeliveryTolerancePercent: tolerance,
        updatedAt: new Date(),
      };
      return currentPolicy;
    }),

    getPurchaseOrder: jest.fn(async (id: string) => poStore.get(id) || null),

    createGRN: jest.fn(async (header: any, items: any[], _actor: any) => {
      const id = randomUUID();
      const newGrn: GoodsReceiptEntity = {
        id,
        grnNumber: header.grnNumber,
        purchaseOrderId: header.purchaseOrderId,
        receivedAt: header.receivedAt || new Date().toISOString(),
        status: GrnStatus.DRAFT,
        referenceNote: header.referenceNote || null,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: items.map((it, idx) => ({
          id: randomUUID(),
          goodsReceiptId: id,
          purchaseOrderItemId: it.purchaseOrderItemId,
          lineNumber: idx + 1,
          lotNumber: it.lotNumber || null,
          receivedQuantity: String(it.receivedQuantity),
          acceptedQuantity: String(it.acceptedQuantity ?? '0.0000'),
          rejectedQuantity: String(it.rejectedQuantity ?? '0.0000'),
          damageNote: it.damageNote || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      };
      grnStore.set(id, newGrn);
      return JSON.parse(JSON.stringify(newGrn));
    }),

    findById: jest.fn(async (id: string) => {
      const grn = grnStore.get(id);
      return grn ? JSON.parse(JSON.stringify(grn)) : null;
    }),

    updateDraftGRN: jest.fn(async (id: string, updateData: any, itemsData?: any[]) => {
      const existing = grnStore.get(id);
      if (!existing) return null;
      if (existing.status !== GrnStatus.DRAFT) {
        throw new ConflictException('Only DRAFT receipts can be edited');
      }
      existing.referenceNote = updateData.referenceNote ?? existing.referenceNote;
      existing.receivedAt = updateData.receivedAt ?? existing.receivedAt;
      if (itemsData && itemsData.length > 0) {
        existing.items = itemsData.map((it, idx) => ({
          id: randomUUID(),
          goodsReceiptId: id,
          purchaseOrderItemId: it.purchaseOrderItemId,
          lineNumber: idx + 1,
          lotNumber: it.lotNumber || null,
          receivedQuantity: String(it.receivedQuantity),
          acceptedQuantity: String(it.acceptedQuantity ?? '0.0000'),
          rejectedQuantity: String(it.rejectedQuantity ?? '0.0000'),
          damageNote: it.damageNote || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
      }
      grnStore.set(id, existing);
      return JSON.parse(JSON.stringify(existing));
    }),

    receiveGRN: jest.fn(async (id: string) => {
      const grn = grnStore.get(id);
      if (!grn) throw new Error('Not found');
      if (grn.status !== GrnStatus.DRAFT) throw new ConflictException('GRN not DRAFT');

      const po = poStore.get(grn.purchaseOrderId);
      if (!po) throw new Error('PO not found');

      // Check classification
      for (const item of grn.items || []) {
        const total = new Decimal(item.acceptedQuantity).plus(new Decimal(item.rejectedQuantity));
        if (!total.equals(new Decimal(item.receivedQuantity))) {
          throw new ConflictException('Unclassified quantity upon receipt');
        }
      }

      // Check over-delivery tolerance
      const tolerance = new Decimal(currentPolicy.overDeliveryTolerancePercent);
      for (const item of grn.items || []) {
        const poItem = po.items.find((i: any) => i.id === item.purchaseOrderItemId);
        if (poItem) {
          const ordered = new Decimal(poItem.orderedQuantity);
          const allowed = ordered.times(new Decimal(1).plus(tolerance.dividedBy(100)));
          const currentAccepted = new Decimal(item.acceptedQuantity);
          if (currentAccepted.gt(allowed)) {
            throw new ConflictException(`Over-delivery tolerance exceeded on item ${poItem.id}`);
          }
        }
      }

      grn.status = GrnStatus.RECEIVED;
      grn.updatedAt = new Date();
      grnStore.set(id, grn);

      // Recalculate PO
      po.status = PurchaseOrderStatus.PARTIALLY_RECEIVED;
      po.version += 1;
      poStore.set(po.id, po);

      return {
        grn: JSON.parse(JSON.stringify(grn)),
        poStatus: po.status,
        poVersion: po.version,
      };
    }),

    cancelGRN: jest.fn(async (id: string, reason: string) => {
      const grn = grnStore.get(id);
      if (!grn) throw new Error('Not found');
      if (grn.status === GrnStatus.CANCELLED) throw new ConflictException('Already cancelled');

      const po = poStore.get(grn.purchaseOrderId);
      if (
        grn.status === GrnStatus.RECEIVED &&
        po &&
        (po.status === PurchaseOrderStatus.CLOSED || po.status === PurchaseOrderStatus.CANCELLED)
      ) {
        throw new ConflictException('Cannot cancel GRN on terminal PO');
      }

      grn.status = GrnStatus.CANCELLED;
      grn.cancelledAt = new Date();
      grn.cancelledReason = reason;
      grn.updatedAt = new Date();
      grnStore.set(id, grn);

      return {
        grn: JSON.parse(JSON.stringify(grn)),
      };
    }),

    findAll: jest.fn(async () => ({
      data: Array.from(grnStore.values()),
      page: 1,
      limit: 20,
      total: grnStore.size,
    })),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthService)
      .useValue(mockAuthService)
      .overrideProvider(GoodsReceiptsRepository)
      .useValue(mockRepository)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  let createdGrnId: string;

  describe('1. RBAC & Access Control', () => {
    it('buyer cannot create GRN -> 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .post('/goods-receipts')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          purchaseOrderId: PO_ISSUED_ID,
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              receivedQuantity: '10.0000',
              acceptedQuantity: '10.0000',
              rejectedQuantity: '0.0000',
            },
          ],
        })
        .expect(403);
    });

    it('warehouse can create GRN -> 201 Created', async () => {
      const res = await request(app.getHttpServer())
        .post('/goods-receipts')
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          purchaseOrderId: PO_ISSUED_ID,
          referenceNote: 'Shipment 1',
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              lotNumber: 'LOT-A1',
              receivedQuantity: '20.0000',
              acceptedQuantity: '15.0000',
              rejectedQuantity: '5.0000',
              damageNote: '5 units damaged packaging',
            },
          ],
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.grnNumber).toMatch(/^GRN-2026-\d{6}$/);
      createdGrnId = res.body.id;
    });

    it('buyer can read GRNs -> 200 OK', async () => {
      await request(app.getHttpServer())
        .get('/goods-receipts')
        .set('Authorization', 'Bearer buyer-token')
        .expect(200);
    });

    it('warehouse cannot update policy -> 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .patch('/goods-receipts/policy')
        .set('Authorization', 'Bearer warehouse-token')
        .send({ overDeliveryTolerancePercent: '10.00' })
        .expect(403);
    });

    it('admin can update policy -> 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .patch('/goods-receipts/policy')
        .set('Authorization', 'Bearer admin-token')
        .send({ overDeliveryTolerancePercent: '5.00' })
        .expect(200);

      expect(res.body.overDeliveryTolerancePercent).toBe('5.00');
    });
  });

  describe('2. Validation & Business Constraints', () => {
    it('rejects GRN against non-active PO (DRAFT PO) -> 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .post('/goods-receipts')
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          purchaseOrderId: PO_DRAFT_ID,
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              receivedQuantity: '10.0000',
              acceptedQuantity: '10.0000',
              rejectedQuantity: '0.0000',
            },
          ],
        })
        .expect(400);
    });

    it('rejects rejectedQuantity > 0 without damageNote -> 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .post('/goods-receipts')
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          purchaseOrderId: PO_ISSUED_ID,
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              receivedQuantity: '10.0000',
              acceptedQuantity: '8.0000',
              rejectedQuantity: '2.0000',
              damageNote: '',
            },
          ],
        })
        .expect(400);
    });

    it('rejects rejectedQuantity > 0 with whitespace-only damageNote -> 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .post('/goods-receipts')
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          purchaseOrderId: PO_ISSUED_ID,
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              receivedQuantity: '10.0000',
              acceptedQuantity: '8.0000',
              rejectedQuantity: '2.0000',
              damageNote: '    ',
            },
          ],
        })
        .expect(400);
    });

    it('rejects native JavaScript numbers -> 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .post('/goods-receipts')
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          purchaseOrderId: PO_ISSUED_ID,
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              receivedQuantity: 10,
              acceptedQuantity: '10.0000',
              rejectedQuantity: '0.0000',
            },
          ],
        })
        .expect(400);
    });

    it('rejects scale > 4 decimal places -> 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .post('/goods-receipts')
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          purchaseOrderId: PO_ISSUED_ID,
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              receivedQuantity: '10.00005',
              acceptedQuantity: '10.0000',
              rejectedQuantity: '0.0000',
            },
          ],
        })
        .expect(400);
    });
  });

  describe('3. Lifecycle: Receive & Cancel', () => {
    it('updates DRAFT GRN to be fully classified', async () => {
      await request(app.getHttpServer())
        .patch(`/goods-receipts/${createdGrnId}`)
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          items: [
            {
              purchaseOrderItemId: PO_ITEM_1_ID,
              receivedQuantity: '20.0000',
              acceptedQuantity: '20.0000',
              rejectedQuantity: '0.0000',
            },
          ],
        })
        .expect(200);
    });

    it('receives DRAFT GRN -> 200 OK and updates PO status', async () => {
      const res = await request(app.getHttpServer())
        .post(`/goods-receipts/${createdGrnId}/receive`)
        .set('Authorization', 'Bearer warehouse-token')
        .expect(200);

      expect(res.body.grn.status).toBe('RECEIVED');
      expect(res.body.poStatus).toBe('PARTIALLY_RECEIVED');
    });

    it('rejects cancelling a RECEIVED GRN when parent PO is CLOSED or CANCELLED -> 409 Conflict', async () => {
      const po = poStore.get(PO_ISSUED_ID);
      const originalStatus = po.status;
      try {
        po.status = PurchaseOrderStatus.CLOSED;
        await request(app.getHttpServer())
          .post(`/goods-receipts/${createdGrnId}/cancel`)
          .set('Authorization', 'Bearer warehouse-token')
          .send({ reason: 'Attempt cancel on closed PO' })
          .expect(409);

        po.status = PurchaseOrderStatus.CANCELLED;
        await request(app.getHttpServer())
          .post(`/goods-receipts/${createdGrnId}/cancel`)
          .set('Authorization', 'Bearer warehouse-token')
          .send({ reason: 'Attempt cancel on cancelled PO' })
          .expect(409);
      } finally {
        po.status = originalStatus;
      }
    });

    it('cancels GRN with required reason -> 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .post(`/goods-receipts/${createdGrnId}/cancel`)
        .set('Authorization', 'Bearer warehouse-token')
        .send({ reason: 'Quality inspection revealed supplier defect' })
        .expect(200);

      expect(res.body.grn.status).toBe('CANCELLED');
    });

    it('rejects cancellation without reason -> 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .post(`/goods-receipts/${createdGrnId}/cancel`)
        .set('Authorization', 'Bearer warehouse-token')
        .send({ reason: '   ' })
        .expect(400);
    });
  });
});
