import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UploadedFiles,
  UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { InvoicesService } from './invoices.service';
import { InvoicesRepository } from './invoices.repository';
import { IngestInvoiceDto } from './dto/ingest-invoice.dto';
import { QueryInvoiceDto } from './dto/query-invoice.dto';
import { UploadedInvoiceFiles } from './interfaces/invoice.interface';
import { fileLimit } from './domain/file-validation';
import { IngestionExceptionFilter } from './ingestion-exception.filter';

@ApiTags('Invoices') @ApiBearerAuth('bearer')
@Controller('invoices') @UseGuards(JwtAuthGuard, RolesGuard) @UseFilters(IngestionExceptionFilter)
export class InvoicesController {
  constructor(private readonly service: InvoicesService, private readonly repository: InvoicesRepository) {}

  @Post('ingest') @Roles('accountant', 'admin')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'xml', maxCount: 1 }, { name: 'pdf', maxCount: 1 }], {
    limits: { fileSize: Math.max(fileLimit('XML'), fileLimit('PDF')), files: 2, fields: 1, parts: 3, fieldSize: 100 },
  }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Archive and ingest invoice XML/PDF bound to a purchase order' })
  @ApiBody({ schema: { type: 'object', required: ['purchaseOrderId'], properties: {
    purchaseOrderId: { type: 'string', format: 'uuid' },
    xml: { type: 'string', format: 'binary' }, pdf: { type: 'string', format: 'binary' },
  } } })
  @ApiResponse({ status: 201, description: 'Supported XML persisted atomically; PARSED' })
  @ApiResponse({ status: 202, description: 'PDF archived; OCR_REQUIRED / NOT_CONFIGURED, no invoice row' })
  @ApiResponse({ status: 400, description: 'Invalid request or upload fields' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Accountant or admin role required' })
  @ApiResponse({ status: 409, description: 'DUPLICATE_INVOICE' })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 415, description: 'UNSUPPORTED_MEDIA_TYPE' })
  @ApiResponse({ status: 422, description: 'Malformed/unsafe/unsupported XML, precision, totals or seller mismatch' })
  @ApiResponse({ status: 503, description: 'Upload, checksum or persistence failure; ingestion remains traceable' })
  async ingest(@Body() dto: IngestInvoiceDto, @UploadedFiles() files: UploadedInvoiceFiles,
    @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.ingest(dto.purchaseOrderId, files, user);
    response.status(result.status === 'PARSED' ? 201 : 202);
    return result;
  }
  @Get() @Roles('accountant', 'admin', 'finance_manager', 'buyer')
  list(@Query() query: QueryInvoiceDto) { return this.repository.list(query); }
  @Get(':id/files') @Roles('accountant', 'admin', 'finance_manager', 'buyer')
  files(@Param('id', ParseUUIDPipe) id: string) { return this.repository.files(id); }
  @Get(':id') @Roles('accountant', 'admin', 'finance_manager', 'buyer')
  invoice(@Param('id', ParseUUIDPipe) id: string) { return this.repository.invoice(id); }
}

@ApiTags('Invoice ingestions') @ApiBearerAuth('bearer')
@Controller('invoice-ingestions') @UseGuards(JwtAuthGuard, RolesGuard) @UseFilters(IngestionExceptionFilter)
export class InvoiceIngestionsController {
  constructor(private readonly repository: InvoicesRepository) {}
  @Get(':id') @Roles('accountant', 'admin', 'finance_manager', 'buyer')
  ingestion(@Param('id', ParseUUIDPipe) id: string) { return this.repository.ingestion(id); }
}
