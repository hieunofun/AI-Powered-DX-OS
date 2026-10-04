import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';

@Module({
  imports: [DatabaseModule, HealthModule, AuthModule, PurchaseOrdersModule],
  controllers: [],
  providers: [],
})
export class AppModule {}

