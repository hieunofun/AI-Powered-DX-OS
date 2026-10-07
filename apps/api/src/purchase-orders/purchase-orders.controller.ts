import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { PurchaseOrdersService } from './purchase-orders.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { IssuePurchaseOrderDto } from './dto/issue-purchase-order.dto';
import { CancelPurchaseOrderDto } from './dto/cancel-purchase-order.dto';
import { QueryPurchaseOrderDto } from './dto/query-purchase-order.dto';
import { QuerySupplierDto } from './dto/query-supplier.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

@ApiTags('Purchase Orders')
@ApiBearerAuth('bearer')
@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PurchaseOrdersController {
  constructor(private readonly poService: PurchaseOrdersService) {}

  /**
   * Creates a new Purchase Order in DRAFT status with nested line items.
   */
  @Post()
  @Roles('buyer', 'admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new Purchase Order in DRAFT status' })
  @ApiResponse({ status: 201, description: 'Purchase Order successfully created' })
  @ApiResponse({ status: 400, description: 'Validation failed or inactive supplier' })
  @ApiResponse({ status: 401, description: 'Missing or invalid authentication token' })
  @ApiResponse({ status: 403, description: 'Forbidden: Requires buyer or admin role' })
  async create(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.poService.create(dto, user);
  }

  /**
   * Retrieves a paginated list of Purchase Orders with optional status/supplier/number filtering.
   */
  @Get()
  @Roles('buyer', 'admin', 'warehouse', 'accountant', 'finance_manager')
  @ApiOperation({ summary: 'List Purchase Orders with pagination and filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of Purchase Orders' })
  @ApiResponse({ status: 401, description: 'Missing or invalid authentication token' })
  async findAll(@Query() query: QueryPurchaseOrderDto) {
    return this.poService.findAll(query);
  }

  @Get('suppliers')
  @Roles('buyer', 'admin', 'warehouse', 'accountant', 'finance_manager')
  @ApiOperation({ summary: 'Read-only paginated supplier lookup for procurement forms' })
  findSuppliers(@Query() query: QuerySupplierDto) {
    return this.poService.findSuppliers(query);
  }

  @Get(':id/fulfillment')
  @Roles('buyer', 'admin', 'warehouse', 'accountant', 'finance_manager')
  @ApiOperation({ summary: 'Cumulative accepted and rejected quantities from finalized, non-cancelled receipts' })
  findFulfillment(@Param('id', ParseUUIDPipe) id: string) {
    return this.poService.findFulfillment(id);
  }

  /**
   * Retrieves a single Purchase Order by ID, including its line items.
   */
  @Get(':id')
  @Roles('buyer', 'admin', 'warehouse', 'accountant', 'finance_manager')
  @ApiOperation({ summary: 'Get Purchase Order by ID with line items' })
  @ApiParam({ name: 'id', description: 'Purchase Order UUID' })
  @ApiResponse({ status: 200, description: 'Purchase Order details with line items' })
  @ApiResponse({ status: 401, description: 'Missing or invalid authentication token' })
  @ApiResponse({ status: 404, description: 'Purchase Order not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.poService.findById(id);
  }

  /**
   * Updates attributes and line items of a DRAFT Purchase Order using optimistic locking.
   */
  @Patch(':id')
  @Roles('buyer', 'admin')
  @ApiOperation({ summary: 'Update DRAFT Purchase Order (optimistic locking enforced)' })
  @ApiParam({ name: 'id', description: 'Purchase Order UUID' })
  @ApiResponse({ status: 200, description: 'Purchase Order updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid update payload' })
  @ApiResponse({ status: 401, description: 'Missing or invalid authentication token' })
  @ApiResponse({ status: 403, description: 'Forbidden: Requires buyer or admin role' })
  @ApiResponse({ status: 404, description: 'Purchase Order not found' })
  @ApiResponse({ status: 409, description: 'Conflict: Stale version or order is not in DRAFT' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.poService.update(id, dto, user);
  }

  /**
   * Issues a Purchase Order: Transitions DRAFT -> ISSUED.
   */
  @Post(':id/issue')
  @Roles('buyer', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue Purchase Order (DRAFT -> ISSUED transition)' })
  @ApiParam({ name: 'id', description: 'Purchase Order UUID' })
  @ApiResponse({ status: 200, description: 'Purchase Order transitioned to ISSUED' })
  @ApiResponse({ status: 400, description: 'Validation failed or inactive supplier' })
  @ApiResponse({ status: 401, description: 'Missing or invalid authentication token' })
  @ApiResponse({ status: 403, description: 'Forbidden: Requires buyer or admin role' })
  @ApiResponse({ status: 404, description: 'Purchase Order not found' })
  @ApiResponse({ status: 409, description: 'Conflict: Stale version or order is not in DRAFT' })
  async issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssuePurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.poService.issue(id, dto, user);
  }

  /**
   * Cancels a Purchase Order: Transitions DRAFT/ISSUED -> CANCELLED with mandatory reason.
   */
  @Post(':id/cancel')
  @Roles('buyer', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel Purchase Order with mandatory reason' })
  @ApiParam({ name: 'id', description: 'Purchase Order UUID' })
  @ApiResponse({ status: 200, description: 'Purchase Order transitioned to CANCELLED' })
  @ApiResponse({ status: 400, description: 'Cancellation reason missing or blank' })
  @ApiResponse({ status: 401, description: 'Missing or invalid authentication token' })
  @ApiResponse({ status: 403, description: 'Forbidden: Requires buyer or admin role' })
  @ApiResponse({ status: 404, description: 'Purchase Order not found' })
  @ApiResponse({ status: 409, description: 'Conflict: Stale version or order not cancellable' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.poService.cancel(id, dto, user);
  }
}
