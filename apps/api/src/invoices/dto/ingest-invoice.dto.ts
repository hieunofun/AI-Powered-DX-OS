import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class IngestInvoiceDto {
  @ApiProperty({ format: 'uuid', description: 'Issued or received PO; supplier is derived by the backend.' })
  @IsUUID()
  purchaseOrderId: string;
}
