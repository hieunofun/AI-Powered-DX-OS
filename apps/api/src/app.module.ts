import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { GoodsReceiptsModule } from './goods-receipts/goods-receipts.module';
import { InvoicesModule } from './invoices/invoices.module';
import { MatchingModule } from './matching/matching.module';

@Module({
  imports: [DatabaseModule, HealthModule, AuthModule, PurchaseOrdersModule, GoodsReceiptsModule, InvoicesModule, MatchingModule],
  controllers: [],
  providers: [],
})
export class AppModule {}

