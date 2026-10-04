import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PurchaseOrdersRepository } from './purchase-orders.repository';
import { POCalculator } from './domain/po-calculator';
import { POStateMachine } from './domain/po-state-machine';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { IssuePurchaseOrderDto } from './dto/issue-purchase-order.dto';
import { CancelPurchaseOrderDto } from './dto/cancel-purchase-order.dto';
import { QueryPurchaseOrderDto } from './dto/query-purchase-order.dto';
import {
  PurchaseOrderEntity,
  PaginatedResult,
} from './interfaces/purchase-order.interface';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

@Injectable()
export class PurchaseOrdersService {
  constructor(private readonly repository: PurchaseOrdersRepository) {}

  /**
   * Creates a new Purchase Order in DRAFT status.
   */
  async create(
    dto: CreatePurchaseOrderDto,
    user: AuthenticatedUser,
  ): Promise<PurchaseOrderEntity> {
    // 1. Verify Supplier exists and is ACTIVE
    const supplier = await this.repository.getSupplier(dto.supplierId);
    if (!supplier) {
      throw new BadRequestException(`Supplier with ID '${dto.supplierId}' not found.`);
    }
    if (supplier.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Supplier '${supplier.name}' (ID: ${supplier.id}) is not active (current status: ${supplier.status}). Cannot issue Purchase Order to inactive supplier.`,
      );
    }

    // 2. Validate line items
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('A Purchase Order must contain at least one line item.');
    }

    // 3. Compute deterministic calculations for each line item (server-calculated, never trust client totals)
    const calculatedItems = dto.items.map((item, idx) => {
      const lineMath = POCalculator.calculateLine(
        item.orderedQuantity,
        item.unitPrice,
        item.taxRate ?? 0,
      );
      return {
        lineNumber: idx + 1,
        sku: item.sku || null,
        description: item.description,
        orderedQuantity: item.orderedQuantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate ?? 0,
        ...lineMath,
      };
    });

    // 4. Compute cumulative totals
    const totals = POCalculator.calculateTotals(calculatedItems);

    // 5. Generate concurrency-safe PO number
    const poNumber = await this.repository.generatePoNumber();

    // 6. Atomically persist PO header, items, and audit trail
    return this.repository.createPO(
      {
        poNumber,
        supplierId: dto.supplierId,
        currency: dto.currency.toUpperCase(),
        orderDate: dto.orderDate,
        expectedDeliveryDate: dto.expectedDeliveryDate,
        ...totals,
      },
      calculatedItems,
      {
        subject: user.sub,
        roles: user.roles,
      },
    );
  }

  /**
   * Retrieves a paginated list of Purchase Orders.
   */
  async findAll(query: QueryPurchaseOrderDto): Promise<PaginatedResult<PurchaseOrderEntity>> {
    return this.repository.findAll(query);
  }

  /**
   * Retrieves a single Purchase Order by ID.
   */
  async findById(id: string): Promise<PurchaseOrderEntity> {
    const po = await this.repository.findById(id);
    if (!po) {
      throw new NotFoundException(`Purchase Order with ID '${id}' not found.`);
    }
    return po;
  }

  /**
   * Modifies an existing DRAFT Purchase Order using optimistic locking.
   */
  async update(
    id: string,
    dto: UpdatePurchaseOrderDto,
    user: AuthenticatedUser,
  ): Promise<PurchaseOrderEntity> {
    const po = await this.findById(id);

    // Business rule: only DRAFT orders can be updated
    try {
      POStateMachine.assertCanModify(po.status);
    } catch (err: any) {
      throw new ConflictException(err.message);
    }

    // If supplier updated, verify supplier is ACTIVE
    if (dto.supplierId && dto.supplierId !== po.supplierId) {
      const supplier = await this.repository.getSupplier(dto.supplierId);
      if (!supplier) {
        throw new BadRequestException(`Supplier with ID '${dto.supplierId}' not found.`);
      }
      if (supplier.status !== 'ACTIVE') {
        throw new BadRequestException(
          `Supplier '${supplier.name}' is inactive. Cannot update Purchase Order with inactive supplier.`,
        );
      }
    }

    let calculatedItems;
    let totals: { subtotal?: number; taxAmount?: number; totalAmount?: number } = {};

    if (dto.items && dto.items.length > 0) {
      calculatedItems = dto.items.map((item, idx) => {
        const lineMath = POCalculator.calculateLine(
          item.orderedQuantity,
          item.unitPrice,
          item.taxRate ?? 0,
        );
        return {
          lineNumber: idx + 1,
          sku: item.sku || null,
          description: item.description,
          orderedQuantity: item.orderedQuantity,
          unitPrice: item.unitPrice,
          taxRate: item.taxRate ?? 0,
          ...lineMath,
        };
      });

      totals = POCalculator.calculateTotals(calculatedItems);
    }

    return this.repository.updateDraftPO(
      id,
      dto.expectedVersion,
      {
        supplierId: dto.supplierId,
        currency: dto.currency ? dto.currency.toUpperCase() : undefined,
        orderDate: dto.orderDate,
        expectedDeliveryDate: dto.expectedDeliveryDate,
        ...totals,
      },
      calculatedItems,
      {
        subject: user.sub,
        roles: user.roles,
      },
    );
  }

  /**
   * Issues a Purchase Order: Transitions DRAFT -> ISSUED.
   */
  async issue(
    id: string,
    dto: IssuePurchaseOrderDto,
    user: AuthenticatedUser,
  ): Promise<PurchaseOrderEntity> {
    const po = await this.findById(id);

    try {
      POStateMachine.assertCanIssue(po.status);
    } catch (err: any) {
      throw new ConflictException(err.message);
    }

    // Verify supplier is still active before issuing
    const supplier = await this.repository.getSupplier(po.supplierId);
    if (!supplier || supplier.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot issue Purchase Order: Associated supplier is not active.`,
      );
    }

    if (!po.items || po.items.length === 0) {
      throw new BadRequestException('Cannot issue Purchase Order with zero line items.');
    }

    return this.repository.issuePO(id, dto.expectedVersion, {
      subject: user.sub,
      roles: user.roles,
    });
  }

  /**
   * Cancels a Purchase Order: Transitions DRAFT -> CANCELLED or ISSUED -> CANCELLED.
   */
  async cancel(
    id: string,
    dto: CancelPurchaseOrderDto,
    user: AuthenticatedUser,
  ): Promise<PurchaseOrderEntity> {
    const po = await this.findById(id);

    try {
      POStateMachine.assertCanCancel(po.status);
    } catch (err: any) {
      throw new ConflictException(err.message);
    }

    const trimmedReason = dto.reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException('Cancellation reason is required and cannot be blank.');
    }

    return this.repository.cancelPO(id, dto.expectedVersion, trimmedReason, {
      subject: user.sub,
      roles: user.roles,
    });
  }
}
