import { Module } from '@nestjs/common';
import { CashService } from './cash.service';
import { CashController } from './cash.controller';

@Module({
  providers: [CashService],
  controllers: [CashController],
  exports: [CashService],
})
export class CashModule {}
