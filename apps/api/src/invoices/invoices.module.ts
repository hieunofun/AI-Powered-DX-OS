import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { InvoicesController, InvoiceIngestionsController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicesRepository } from './invoices.repository';
import { SmartProcureInvoiceV1Parser } from './parsers/smartprocure-invoice-v1.parser';
import { MatbaoInvoiceV200Parser } from './parsers/matbao-invoice-v200.parser';
import { InvoiceXmlParserService } from './parsers/invoice-xml-parser.service';
import { INVOICE_OCR_PROVIDER } from './ocr/invoice-ocr-provider';
import { PendingOcrProvider } from './ocr/pending-ocr.provider';

@Module({ imports: [DatabaseModule, AuthModule, StorageModule],
  controllers: [InvoicesController, InvoiceIngestionsController],
  providers: [InvoicesService, InvoicesRepository, SmartProcureInvoiceV1Parser, MatbaoInvoiceV200Parser, InvoiceXmlParserService,
    { provide: INVOICE_OCR_PROVIDER, useClass: PendingOcrProvider }] })
export class InvoicesModule {}
