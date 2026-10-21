import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DbModule } from './db/db.module';
import { PlatformModule } from './modules/platform/platform.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { PermissionsGuard } from './modules/auth/permissions.guard';
import { HealthModule } from './modules/health/health.module';
import { DeviceModule } from './modules/devices/device.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { CashModule } from './modules/cash/cash.module';
import { SyncModule } from './modules/sync/sync.module';
import { LicensingModule } from './modules/licensing/licensing.module';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    DbModule,
    PlatformModule,
    AuthModule,
    HealthModule,
    DeviceModule,
    CatalogModule,
    InventoryModule,
    PricingModule,
    CashModule,
    SyncModule,
    LicensingModule,
  ],
  providers: [
    // Order matters: authenticate first, then enforce permissions (§9, §10).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
