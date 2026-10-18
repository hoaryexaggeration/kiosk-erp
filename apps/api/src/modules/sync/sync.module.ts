import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SaleService } from '../sales/sale.service';

@Module({
  providers: [SyncService, SaleService],
  controllers: [SyncController],
})
export class SyncModule {}
