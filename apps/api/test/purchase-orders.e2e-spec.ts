import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { PurchaseOrdersRepository } from '../src/purchase-orders/purchase-orders.repository';
import { PurchaseOrderStatus } from '../src/purchase-orders/domain/po-state-machine';
import { PurchaseOrderEntity } from '../src/purchase-orders/interfaces/purchase-order.interface';

describe('PurchaseOrdersController (e2e)', () => {
  let app: INestApplication;

  const mockBuyer = {
    sub: 'sub-buyer-1234',
    username: 'buyer.demo',
    email: 'buyer.demo@smartprocure.local',
    roles: ['buyer'],
  };

  const mockAdmin = {
    sub: 'sub-admin-5678',
    username: 'admin.demo',
    email: 'admin.demo@smartprocure.local',
    roles: ['admin'],
  };

  const mockWarehouse = {
    sub: 'sub-warehouse-9999',
    username: 'warehouse.demo',
    email: 'warehouse.demo@smartprocure.local',
    roles: ['warehouse'],
  };

  const mockAuthService = {
    verifyToken: jest.fn(async (token: string) => {
      if (token === 'buyer-token') return mockBuyer;
      if (token === 'admin-token') return mockAdmin;
      if (token === 'warehouse-token') return mockWarehouse;
      throw new UnauthorizedException('Invalid token');
    }),
  };

  const ACTIVE_SUPPLIER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const INACTIVE_SUPPLIER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
  let poUuidCounter = 1;

  // In-memory store for repository mock
  const suppliersStore: Record<string, { id: string; name: string; status: string }> = {
    [ACTIVE_SUPPLIER_ID]: { id: ACTIVE_SUPPLIER_ID, name: 'Active Supplier Corp', status: 'ACTIVE' },
    [INACTIVE_SUPPLIER_ID]: { id: INACTIVE_SUPPLIER_ID, name: 'Inactive Supplier LLC', status: 'INACTIVE' },
  };

  const poStore = new Map<string, PurchaseOrderEntity>();
  const auditStore: Array<{ entityId: string; eventType: string; payload: any }> = [];
  let poCounter = 1;

  const mockRepository = {
    getSupplier: jest.fn(async (id: string) => {
      return suppliersStore[id] || null;
    }),

    generatePoNumber: jest.fn(async () => {
      const num = String(poCounter++).padStart(6, '0');
      return `PO-2026-${num}`;
    }),

    findById: jest.fn(async (id: string) => {
      const po = poStore.get(id);
      return po ? JSON.parse(JSON.stringify(po)) : null;
    }),

    findAll: jest.fn(async (query: any) => {
      const all = Array.from(poStore.values());
      const filtered = all.filter((po) => {
        if (query.status && po.status !== query.status) return false;
        if (query.supplierId && po.supplierId !== query.supplierId) return false;
        if (query.poNumber && !po.poNumber.includes(query.poNumber)) return false;
        return true;
      });
      const page = query.page || 1;
      const limit = query.limit || 20;
      const start = (page - 1) * limit;
      return {
        data: filtered.slice(start, start + limit),
        page,
        limit,
        total: filtered.length,
      };
    }),

    createPO: jest.fn(async (poData: any, itemsData: any[], actor: any) => {
      // Simulate atomic rollback if an item has invalid data
      for (const item of itemsData) {
        if (item.orderedQuantity <= 0) {
          throw new Error('Database check constraint violation: ordered_quantity > 0');
        }
      }

      const id = `00000000-0000-0000-0000-${String(poUuidCounter++).padStart(12, '0')}`;
      const newPo: PurchaseOrderEntity = {
        id,
        poNumber: poData.poNumber,
        supplierId: poData.supplierId,
        currency: poData.currency,
        status: PurchaseOrderStatus.DRAFT,
        orderDate: poData.orderDate,
        expectedDeliveryDate: poData.expectedDeliveryDate,
        subtotal: poData.subtotal,
        taxAmount: poData.taxAmount,
        totalAmount: poData.totalAmount,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: itemsData.map((it, idx) => ({
          id: `11111111-1111-1111-1111-${String(idx + 1).padStart(12, '0')}`,
          purchaseOrderId: id,
          lineNumber: it.lineNumber,
          sku: it.sku || null,
          description: it.description,
          orderedQuantity: String(it.orderedQuantity),
          unitPrice: String(it.unitPrice),
          taxRate: String(it.taxRate),
          lineSubtotal: String(it.lineSubtotal),
          taxAmount: String(it.taxAmount),
          lineTotal: String(it.lineTotal),
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      };
      poStore.set(id, newPo);
      auditStore.push({
        entityId: id,
        eventType: 'PO_CREATED',
        payload: { poNumber: newPo.poNumber, actor },
      });
      return JSON.parse(JSON.stringify(newPo));
    }),

    updateDraftPO: jest.fn(
      async (id: string, expectedVersion: number, poData: any, itemsData?: any[], actor?: any) => {
        const existing = poStore.get(id);
        if (!existing) return null;
        if (existing.version !== expectedVersion) {
          const { ConflictException } = await import('@nestjs/common');
          throw new ConflictException('Optimistic lock conflict');
        }
        existing.version += 1;
        if (poData.currency) existing.currency = poData.currency;
        if (poData.subtotal !== undefined) existing.subtotal = poData.subtotal;
        if (poData.taxAmount !== undefined) existing.taxAmount = poData.taxAmount;
        if (poData.totalAmount !== undefined) existing.totalAmount = poData.totalAmount;
        if (itemsData) {
          existing.items = itemsData.map((it) => ({
            id: `item-${Date.now()}-${Math.random()}`,
            purchaseOrderId: id,
            lineNumber: it.lineNumber,
            sku: it.sku || null,
            description: it.description,
            orderedQuantity: it.orderedQuantity,
            unitPrice: it.unitPrice,
            taxRate: it.taxRate,
            lineSubtotal: it.lineSubtotal,
            taxAmount: it.taxAmount,
            lineTotal: it.lineTotal,
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
        }
        existing.updatedAt = new Date();
        poStore.set(id, existing);
        auditStore.push({
          entityId: id,
          eventType: 'PO_UPDATED',
          payload: { actor, version: existing.version },
        });
        return JSON.parse(JSON.stringify(existing));
      },
    ),

    issuePO: jest.fn(async (id: string, expectedVersion: number, actor: any) => {
      const existing = poStore.get(id);
      if (!existing) return null;
      if (existing.version !== expectedVersion) {
        const { ConflictException } = await import('@nestjs/common');
        throw new ConflictException('Optimistic lock conflict');
      }
      if (existing.status !== PurchaseOrderStatus.DRAFT) {
        const { ConflictException } = await import('@nestjs/common');
        throw new ConflictException('Cannot issue non-DRAFT PO');
      }
      existing.status = PurchaseOrderStatus.ISSUED;
      existing.version += 1;
      existing.updatedAt = new Date();
      poStore.set(id, existing);
      auditStore.push({
        entityId: id,
        eventType: 'PO_ISSUED',
        payload: { actor, version: existing.version },
      });
      return JSON.parse(JSON.stringify(existing));
    }),

    cancelPO: jest.fn(async (id: string, expectedVersion: number, reason: string, actor: any) => {
      const existing = poStore.get(id);
      if (!existing) return null;
      if (existing.version !== expectedVersion) {
        const { ConflictException } = await import('@nestjs/common');
        throw new ConflictException('Optimistic lock conflict');
      }
      if (existing.status !== PurchaseOrderStatus.DRAFT && existing.status !== PurchaseOrderStatus.ISSUED) {
        const { ConflictException } = await import('@nestjs/common');
        throw new ConflictException('Cannot cancel PO in status ' + existing.status);
      }
      existing.status = PurchaseOrderStatus.CANCELLED;
      existing.cancelledAt = new Date();
      existing.cancelledReason = reason;
      existing.version += 1;
      existing.updatedAt = new Date();
      poStore.set(id, existing);
      auditStore.push({
        entityId: id,
        eventType: 'PO_CANCELLED',
        payload: { actor, reason, version: existing.version },
      });
      return JSON.parse(JSON.stringify(existing));
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthService)
      .useValue(mockAuthService)
      .overrideProvider(PurchaseOrdersRepository)
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

  let createdPoId: string;

  describe('1 & 2. Role-Based Access Control', () => {
    it('1. buyer creates PO → 201 Created', async () => {
      const res = await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          supplierId: ACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          expectedDeliveryDate: '2026-10-20',
          items: [
            {
              description: 'Industrial Sensor Pack',
              orderedQuantity: 10,
              unitPrice: 150.5,
              taxRate: 0.1,
            },
          ],
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.poNumber).toMatch(/^PO-2026-\d{6}$/);
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.version).toBe(1);
      createdPoId = res.body.id;
    });

    it('2. warehouse creates PO → 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer warehouse-token')
        .send({
          supplierId: ACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          items: [
            {
              description: 'Pallet Fork',
              orderedQuantity: 2,
              unitPrice: 500,
              taxRate: 0.08,
            },
          ],
        })
        .expect(403);
    });
  });

  describe('3, 4 & 5. PO Creation Validations', () => {
    it('3. inactive supplier → 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          supplierId: INACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          items: [
            {
              description: 'Item A',
              orderedQuantity: 5,
              unitPrice: 100,
              taxRate: 0.1,
            },
          ],
        })
        .expect(400);

      expect(res.body.message).toContain('not active');
    });

    it('4. PO with zero items → 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          supplierId: ACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          items: [],
        })
        .expect(400);

      expect(Array.isArray(res.body.message) ? res.body.message.join(' ') : res.body.message).toContain(
        'items should not be empty',
      );
    });

    it('5. invalid quantity (<= 0) → 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          supplierId: ACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          items: [
            {
              description: 'Negative Quantity Item',
              orderedQuantity: -5,
              unitPrice: 100,
              taxRate: 0.1,
            },
          ],
        })
        .expect(400);

      expect(Array.isArray(res.body.message) ? res.body.message.join(' ') : res.body.message).toContain(
        'orderedQuantity must be a valid strictly positive decimal',
      );
    });
  });

  describe('6. Server-Side Monetary Calculation', () => {
    it('6. server calculates totals and forbids client-provided totals', async () => {
      // 6a. Verify client cannot tamper with totals (forbidNonWhitelisted prevents mass assignment)
      await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          supplierId: ACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          subtotal: 999999,
          items: [
            {
              description: 'Precision Item 1',
              orderedQuantity: 3,
              unitPrice: 100.25,
              taxRate: 0.1,
            },
          ],
        })
        .expect(400);

      // 6b. Verify server correctly calculates subtotal, taxAmount, and totalAmount
      const res = await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          supplierId: ACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          items: [
            {
              description: 'Precision Item 1',
              orderedQuantity: 3,
              unitPrice: 100.25,
              taxRate: 0.1, // 10%: subtotal 300.75, tax 30.08, total 330.83
            },
            {
              description: 'Precision Item 2',
              orderedQuantity: 2,
              unitPrice: 49.5,
              taxRate: 0.08, // 8%: subtotal 99.00, tax 7.92, total 106.92
            },
          ],
        })
        .expect(201);

      // Verify server calculation:
      // Subtotal: 300.75 + 99.00 = 399.75
      // Tax: 30.08 + 7.92 = 38.00
      // Total: 399.75 + 38.00 = 437.75
      expect(res.body.subtotal).toBe('399.75');
      expect(res.body.taxAmount).toBe('38.00');
      expect(res.body.totalAmount).toBe('437.75');
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].lineSubtotal).toBe('300.75');
      expect(res.body.items[0].taxAmount).toBe('30.08');
      expect(res.body.items[0].lineTotal).toBe('330.83');
    });
  });

  describe('7 & 8. Retrieval Endpoints', () => {
    it('7. GET /purchase-orders returns paginated list', async () => {
      const res = await request(app.getHttpServer())
        .get('/purchase-orders?page=1&limit=10')
        .set('Authorization', 'Bearer buyer-token')
        .expect(200);

      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(10);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    it('8. GET /purchase-orders/:id returns order with line items', async () => {
      const res = await request(app.getHttpServer())
        .get(`/purchase-orders/${createdPoId}`)
        .set('Authorization', 'Bearer buyer-token')
        .expect(200);

      expect(res.body.id).toBe(createdPoId);
      expect(res.body.items).toBeDefined();
      expect(res.body.items.length).toBeGreaterThan(0);
    });
  });

  describe('9 & 10. Update & Optimistic Locking', () => {
    it('9. update DRAFT with expectedVersion=1 → 200 and version becomes 2', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/purchase-orders/${createdPoId}`)
        .set('Authorization', 'Bearer buyer-token')
        .send({
          expectedVersion: 1,
          currency: 'EUR',
        })
        .expect(200);

      expect(res.body.currency).toBe('EUR');
      expect(res.body.version).toBe(2);
    });

    it('10. stale version update (expectedVersion=1 when actual is 2) → 409 Conflict', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/purchase-orders/${createdPoId}`)
        .set('Authorization', 'Bearer buyer-token')
        .send({
          expectedVersion: 1, // Stale!
          currency: 'GBP',
        })
        .expect(409);

      expect(res.body.message).toContain('Optimistic lock conflict');
    });
  });

  describe('11 & 12. Issue Transition & Immutability', () => {
    it('11. DRAFT → ISSUED with expectedVersion=2 → 200 and status becomes ISSUED', async () => {
      const res = await request(app.getHttpServer())
        .post(`/purchase-orders/${createdPoId}/issue`)
        .set('Authorization', 'Bearer buyer-token')
        .send({
          expectedVersion: 2,
        })
        .expect(200);

      expect(res.body.status).toBe('ISSUED');
      expect(res.body.version).toBe(3);
    });

    it('12. ISSUED content mutation → 409 Conflict (cannot modify ISSUED PO)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/purchase-orders/${createdPoId}`)
        .set('Authorization', 'Bearer buyer-token')
        .send({
          expectedVersion: 3,
          currency: 'JPY',
        })
        .expect(409);

      expect(res.body.message).toContain("Cannot modify Purchase Order in 'ISSUED' status");
    });

    it('13. invalid status transition (re-issuing an already ISSUED PO) → 409 Conflict', async () => {
      const res = await request(app.getHttpServer())
        .post(`/purchase-orders/${createdPoId}/issue`)
        .set('Authorization', 'Bearer buyer-token')
        .send({
          expectedVersion: 3,
        })
        .expect(409);

      expect(res.body.message).toContain("Cannot issue Purchase Order in 'ISSUED' status");
    });
  });

  describe('14 & 15. Cancellation', () => {
    it('14. cancel with blank reason → 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post(`/purchase-orders/${createdPoId}/cancel`)
        .set('Authorization', 'Bearer buyer-token')
        .send({
          expectedVersion: 3,
          reason: '   ',
        })
        .expect(400);

      const msg = Array.isArray(res.body.message) ? res.body.message.join(' ') : res.body.message;
      expect(msg).toContain('Cancellation reason');
    });

    it('15. cancel valid ISSUED order → 200 with CANCELLED status, timestamp, and reason', async () => {
      const res = await request(app.getHttpServer())
        .post(`/purchase-orders/${createdPoId}/cancel`)
        .set('Authorization', 'Bearer buyer-token')
        .send({
          expectedVersion: 3,
          reason: 'Supplier announced inability to fulfill delivery schedule',
        })
        .expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.version).toBe(4);
      expect(res.body.cancelledReason).toBe('Supplier announced inability to fulfill delivery schedule');
      expect(res.body.cancelledAt).toBeDefined();
    });
  });

  describe('16. Audit Recording', () => {
    it('16. audit records created for PO lifecycle events', () => {
      const events = auditStore.map((a) => a.eventType);
      expect(events).toContain('PO_CREATED');
      expect(events).toContain('PO_UPDATED');
      expect(events).toContain('PO_ISSUED');
      expect(events).toContain('PO_CANCELLED');
    });
  });

  describe('17. Transaction Rollback', () => {
    it('17. transaction rollback when an error occurs during creation', async () => {
      const countBefore = poStore.size;
      mockRepository.createPO.mockImplementationOnce(async () => {
        throw new Error('Simulated DB failure during item insertion');
      });

      await request(app.getHttpServer())
        .post('/purchase-orders')
        .set('Authorization', 'Bearer buyer-token')
        .send({
          supplierId: ACTIVE_SUPPLIER_ID,
          currency: 'USD',
          orderDate: '2026-10-04',
          items: [
            {
              description: 'Item to fail',
              orderedQuantity: 1,
              unitPrice: 10,
              taxRate: 0,
            },
          ],
        })
        .expect(500);

      // Verify no PO was retained
      expect(poStore.size).toBe(countBefore);
    });
  });
});
