import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { InvoicesController, InvoiceIngestionsController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicesRepository } from './invoices.repository';
import { VietnamEinvoiceXmlParser } from './parsers/vietnam-einvoice-xml.parser';
import { InvoiceXmlParserService } from './parsers/invoice-xml-parser.service';
import { INVOICE_OCR_PROVIDER } from './ocr/invoice-ocr-provider';
import { PendingOcrProvider } from './ocr/pending-ocr.provider';

@Module({ imports: [DatabaseModule, AuthModule, StorageModule],
  controllers: [InvoicesController, InvoiceIngestionsController],
  providers: [InvoicesService, InvoicesRepository, VietnamEinvoiceXmlParser, InvoiceXmlParserService,
    { provide: INVOICE_OCR_PROVIDER, useClass: PendingOcrProvider }] })
export class InvoicesModule {}
