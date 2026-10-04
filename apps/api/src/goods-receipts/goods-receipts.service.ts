import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { GoodsReceiptsRepository } from './goods-receipts.repository';
import { CreateGoodsReceiptDto } from './dto/create-goods-receipt.dto';
import { UpdateGoodsReceiptDto } from './dto/update-goods-receipt.dto';
import { CancelGoodsReceiptDto } from './dto/cancel-goods-receipt.dto';
import { QueryGoodsReceiptDto } from './dto/query-goods-receipt.dto';
import { UpdateGoodsReceiptPolicyDto } from './dto/update-policy.dto';
import {
  GoodsReceiptEntity,
  GoodsReceiptPolicyEntity,
} from './interfaces/goods-receipt.interface';
import { GrnStatus } from './domain/grn-state-machine';
import { PurchaseOrderStatus } from '../purchase-orders/domain/po-state-machine';
import { FulfillmentCalculator } from './domain/fulfillment-calculator';
import { PaginatedResult } from '../purchase-orders/interfaces/purchase-order.interface';

interface AuthenticatedUser {
  sub?: string;
  roles?: string[];
}

@Injectable()
export class GoodsReceiptsService {
  constructor(private readonly repository: GoodsReceiptsRepository) {}

  /**
   * Creates a new Goods Receipt in DRAFT status.
   */
  async create(dto: CreateGoodsReceiptDto, user: AuthenticatedUser): Promise<GoodsReceiptEntity> {
    // 1. Fetch parent Purchase Order
    const po = await this.repository.getPurchaseOrder(dto.purchaseOrderId);
    if (!po) {
      throw new BadRequestException(`Purchase Order '${dto.purchaseOrderId}' does not exist`);
    }

    // 2. Validate PO Status: must be ISSUED or PARTIALLY_RECEIVED
    if (
      po.status !== PurchaseOrderStatus.ISSUED &&
      po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new BadRequestException(
        `Cannot create Goods Receipt against Purchase Order '${po.poNumber}' in '${po.status}' status. ` +
          `PO must be in 'ISSUED' or 'PARTIALLY_RECEIVED' status.`,
      );
    }

    // 3. Verify item lines belong to parent PO
    const poItemIds = new Set(po.items.map((i) => i.id));
    for (const item of dto.items) {
      if (!poItemIds.has(item.purchaseOrderItemId)) {
        throw new BadRequestException(
          `Purchase Order Item '${item.purchaseOrderItemId}' does not belong to parent PO '${po.poNumber}'`,
        );
      }

      // 4. Validate quantity conservation rules on line item
      try {
        FulfillmentCalculator.validateLineQuantities(
          {
            receivedQuantity: item.receivedQuantity,
            acceptedQuantity: item.acceptedQuantity,
            rejectedQuantity: item.rejectedQuantity,
            damageNote: item.damageNote,
          },
          false, // DRAFT permits unclassified received goods
        );
      } catch (err: any) {
        throw new BadRequestException(err.message);
      }
    }

    // 5. Generate concurrency-safe GRN number
    const grnNumber = await this.repository.generateGrnNumber();

    // 6. Atomically persist DRAFT GRN
    return this.repository.createGRN(
      {
        grnNumber,
        purchaseOrderId: dto.purchaseOrderId,
        receivedAt: dto.receivedAt,
        referenceNote: dto.referenceNote,
      },
      dto.items,
      {
        subject: user.sub,
        roles: user.roles,
      },
    );
  }

  /**
   * Finds a Goods Receipt by ID.
   */
  async findById(id: string): Promise<GoodsReceiptEntity> {
    const grn = await this.repository.findById(id);
    if (!grn) {
      throw new NotFoundException(`Goods Receipt '${id}' not found`);
    }
    return grn;
  }

  /**
   * Retrieves a paginated list of Goods Receipts.
   */
  async findAll(query: QueryGoodsReceiptDto): Promise<PaginatedResult<GoodsReceiptEntity>> {
    return this.repository.findAll(query);
  }

  /**
   * Updates a DRAFT Goods Receipt.
   */
  async update(
    id: string,
    dto: UpdateGoodsReceiptDto,
    user: AuthenticatedUser,
  ): Promise<GoodsReceiptEntity> {
    const grn = await this.findById(id);
    if (grn.status !== GrnStatus.DRAFT) {
      throw new ConflictException(
        `Cannot modify Goods Receipt in '${grn.status}' status. Only 'DRAFT' receipts can be edited.`,
      );
    }

    if (dto.items && dto.items.length > 0) {
      const po = await this.repository.getPurchaseOrder(grn.purchaseOrderId);
      if (!po) {
        throw new NotFoundException(`Parent Purchase Order '${grn.purchaseOrderId}' not found`);
      }
      const poItemIds = new Set(po.items.map((i) => i.id));

      for (const item of dto.items) {
        if (!poItemIds.has(item.purchaseOrderItemId)) {
          throw new BadRequestException(
            `Purchase Order Item '${item.purchaseOrderItemId}' does not belong to parent PO '${po.poNumber}'`,
          );
        }
        try {
          FulfillmentCalculator.validateLineQuantities(
            {
              receivedQuantity: item.receivedQuantity,
              acceptedQuantity: item.acceptedQuantity,
              rejectedQuantity: item.rejectedQuantity,
              damageNote: item.damageNote,
            },
            false,
          );
        } catch (err: any) {
          throw new BadRequestException(err.message);
        }
      }
    }

    const updated = await this.repository.updateDraftGRN(
      id,
      {
        receivedAt: dto.receivedAt,
        referenceNote: dto.referenceNote,
      },
      dto.items,
      {
        subject: user.sub,
        roles: user.roles,
      },
    );

    if (!updated) {
      throw new NotFoundException(`Goods Receipt '${id}' not found`);
    }
    return updated;
  }

  /**
   * Finalizes inspection and transitions Goods Receipt from DRAFT to RECEIVED.
   */
  async receive(
    id: string,
    user: AuthenticatedUser,
  ): Promise<{ grn: GoodsReceiptEntity; poStatus: PurchaseOrderStatus; poVersion: number }> {
    const grn = await this.findById(id);
    if (grn.status !== GrnStatus.DRAFT) {
      throw new ConflictException(
        `Cannot receive Goods Receipt in '${grn.status}' status. Only 'DRAFT' receipts can be received.`,
      );
    }

    return this.repository.receiveGRN(id, {
      subject: user.sub,
      roles: user.roles,
    });
  }

  /**
   * Cancels a Goods Receipt.
   */
  async cancel(
    id: string,
    dto: CancelGoodsReceiptDto,
    user: AuthenticatedUser,
  ): Promise<{ grn: GoodsReceiptEntity; poStatus?: PurchaseOrderStatus; poVersion?: number }> {
    const grn = await this.findById(id);
    if (grn.status === GrnStatus.CANCELLED) {
      throw new ConflictException(`Goods Receipt '${grn.grnNumber}' is already CANCELLED`);
    }

    return this.repository.cancelGRN(id, dto.reason, {
      subject: user.sub,
      roles: user.roles,
    });
  }

  /**
   * Retrieves active warehouse over-delivery policy.
   */
  async getActivePolicy(): Promise<GoodsReceiptPolicyEntity> {
    return this.repository.getActivePolicy();
  }

  /**
   * Updates warehouse over-delivery policy tolerance.
   */
  async updateActivePolicy(
    dto: UpdateGoodsReceiptPolicyDto,
    _user: AuthenticatedUser,
  ): Promise<GoodsReceiptPolicyEntity> {
    return this.repository.updateActivePolicy(dto.overDeliveryTolerancePercent);
  }
}
