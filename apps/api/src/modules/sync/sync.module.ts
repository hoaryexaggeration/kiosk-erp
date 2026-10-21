import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SaleService } from '../sales/sale.service';
import { InventoryModule } from '../inventory/inventory.module';
import { AuthModule } from '../auth/auth.module';
import { CashModule } from '../cash/cash.module';

@Module({
  // CashModule supplies CashService: the drawer commands (item 5.2) are dispatched from here.
  imports: [InventoryModule, AuthModule, CashModule],
  providers: [SyncService, SaleService],
  controllers: [SyncController],
})
export class SyncModule {}
