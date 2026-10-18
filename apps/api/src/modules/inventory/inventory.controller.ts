import { Controller, Get, Query } from '@nestjs/common';
import { AuthContext, CurrentAuth } from '../../common/auth-context';
import { InventoryService } from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('balances')
  async balances(
    @CurrentAuth() ctx: AuthContext,
    @Query('branchId') branchId?: string,
    @Query('limit') limit?: string,
  ) {
    return { balances: await this.inventory.balances(ctx.tenantId, branchId, Number(limit ?? 200) || 200) };
  }

  @Get('movements')
  async movements(
    @CurrentAuth() ctx: AuthContext,
    @Query('productId') productId?: string,
    @Query('limit') limit?: string,
  ) {
    return { movements: await this.inventory.movements(ctx.tenantId, productId, Number(limit ?? 200) || 200) };
  }

  /** Stock value per product, derived from the open FIFO valuation layers (ADR 0009). */
  @Get('valuation')
  async valuation(
    @CurrentAuth() ctx: AuthContext,
    @Query('branchId') branchId?: string,
    @Query('limit') limit?: string,
  ) {
    const lines = await this.inventory.valuation(ctx.tenantId, branchId, Number(limit ?? 200) || 200);
    const totalValueMinor = lines.reduce((s, l) => s + l.valueMinor, 0);
    return { lines, totalValueMinor };
  }
}
