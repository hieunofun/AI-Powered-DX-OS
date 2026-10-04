import { Module } from '@nestjs/common';
import { GoodsReceiptsController } from './goods-receipts.controller';
import { GoodsReceiptsService } from './goods-receipts.service';
import { GoodsReceiptsRepository } from './goods-receipts.repository';

@Module({
  imports: [],
  controllers: [GoodsReceiptsController],
  providers: [GoodsReceiptsService, GoodsReceiptsRepository],
  exports: [GoodsReceiptsService, GoodsReceiptsRepository],
})
export class GoodsReceiptsModule {}
