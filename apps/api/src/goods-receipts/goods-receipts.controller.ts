import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { GoodsReceiptsService } from './goods-receipts.service';
import { CreateGoodsReceiptDto } from './dto/create-goods-receipt.dto';
import { UpdateGoodsReceiptDto } from './dto/update-goods-receipt.dto';
import { CancelGoodsReceiptDto } from './dto/cancel-goods-receipt.dto';
import { QueryGoodsReceiptDto } from './dto/query-goods-receipt.dto';
import { UpdateGoodsReceiptPolicyDto } from './dto/update-policy.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Goods Receipts')
@ApiBearerAuth('bearer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('goods-receipts')
export class GoodsReceiptsController {
  constructor(private readonly service: GoodsReceiptsService) {}

  @Post()
  @Roles('warehouse', 'admin')
  @ApiOperation({
    summary: 'Create a new Goods Receipt (GRN) in DRAFT status',
    description:
      'Creates a new warehouse intake Goods Receipt linked to an active Purchase Order in ISSUED or PARTIALLY_RECEIVED status.',
  })
  @ApiResponse({ status: 201, description: 'Goods Receipt created successfully in DRAFT status' })
  @ApiResponse({ status: 400, description: 'Validation error: invalid PO, cross-PO item reference, or invalid quantity' })
  @ApiResponse({ status: 401, description: 'Unauthorized: missing or invalid Keycloak Bearer JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden: caller lacks warehouse or admin role' })
  async create(
    @Body() dto: CreateGoodsReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('warehouse', 'admin', 'buyer', 'accountant', 'finance_manager')
  @ApiOperation({
    summary: 'List Goods Receipts with pagination and filters',
    description:
      'Retrieves a paginated list of Goods Receipts filtered by PO ID, status, or GRN number.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of Goods Receipts' })
  @ApiResponse({ status: 401, description: 'Unauthorized: missing or invalid Keycloak Bearer JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden: caller lacks required roles' })
  async findAll(@Query() query: QueryGoodsReceiptDto) {
    return this.service.findAll(query);
  }

  @Get('policy')
  @Roles('warehouse', 'admin', 'buyer', 'accountant', 'finance_manager')
  @ApiOperation({
    summary: 'Get active warehouse over-delivery tolerance policy',
    description: 'Retrieves the currently active over-delivery tolerance percentage.',
  })
  @ApiResponse({ status: 200, description: 'Active over-delivery policy details' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getPolicy() {
    return this.service.getActivePolicy();
  }

  @Patch('policy')
  @Roles('admin')
  @ApiOperation({
    summary: 'Update warehouse over-delivery tolerance policy (Admin only)',
    description:
      'Configures the global over-delivery tolerance percentage applied to cumulative accepted receipts.',
  })
  @ApiResponse({ status: 200, description: 'Policy updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid tolerance percentage' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires admin role' })
  async updatePolicy(
    @Body() dto: UpdateGoodsReceiptPolicyDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateActivePolicy(dto, user);
  }

  @Get(':id')
  @Roles('warehouse', 'admin', 'buyer', 'accountant', 'finance_manager')
  @ApiOperation({
    summary: 'Get Goods Receipt by ID',
    description: 'Retrieves full details of a Goods Receipt including its line items.',
  })
  @ApiParam({ name: 'id', description: 'Goods Receipt UUID' })
  @ApiResponse({ status: 200, description: 'Goods Receipt details' })
  @ApiResponse({ status: 404, description: 'Goods Receipt not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @Roles('warehouse', 'admin')
  @ApiOperation({
    summary: 'Update a DRAFT Goods Receipt',
    description:
      'Modifies header fields or item lines of a Goods Receipt in DRAFT status. Prohibited once RECEIVED or CANCELLED.',
  })
  @ApiParam({ name: 'id', description: 'Goods Receipt UUID' })
  @ApiResponse({ status: 200, description: 'Goods Receipt updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data or cross-PO item reference' })
  @ApiResponse({ status: 404, description: 'Goods Receipt not found' })
  @ApiResponse({ status: 409, description: 'Conflict: GRN is not in DRAFT status' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires warehouse or admin role' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGoodsReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @Roles('warehouse', 'admin')
  @ApiOperation({
    summary: 'Finalize inspection and receive Goods Receipt (DRAFT -> RECEIVED)',
    description:
      'Finalizes shipment intake. Enforces full classification (accepted + rejected === received), checks over-delivery tolerance, and updates PO fulfillment status.',
  })
  @ApiParam({ name: 'id', description: 'Goods Receipt UUID' })
  @ApiResponse({ status: 200, description: 'Goods Receipt finalized and received' })
  @ApiResponse({ status: 400, description: 'Unclassified quantity or zero items' })
  @ApiResponse({ status: 404, description: 'Goods Receipt or parent PO not found' })
  @ApiResponse({ status: 409, description: 'Conflict: GRN not DRAFT, PO not active, or over-delivery exceeded' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires warehouse or admin role' })
  async receive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.receive(id, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles('warehouse', 'admin')
  @ApiOperation({
    summary: 'Cancel a Goods Receipt with mandatory reason',
    description:
      'Cancels a Goods Receipt. If cancelling a RECEIVED GRN, automatically recalculates and reverses PO fulfillment status.',
  })
  @ApiParam({ name: 'id', description: 'Goods Receipt UUID' })
  @ApiResponse({ status: 200, description: 'Goods Receipt cancelled successfully' })
  @ApiResponse({ status: 400, description: 'Missing or empty cancellation reason' })
  @ApiResponse({ status: 404, description: 'Goods Receipt not found' })
  @ApiResponse({ status: 409, description: 'Conflict: already cancelled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires warehouse or admin role' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelGoodsReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(id, dto, user);
  }
}
