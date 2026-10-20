import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { AuthContext, AuthedRequest, CurrentAuth, RequirePermissions } from '../../common/auth-context';
import { InventoryService } from './inventory.service';
import { OpeningStockImportSchema, TransfersQuerySchema } from './inventory.schema';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /**
   * Opening-stock import (item 4.5). The permission is `inventory.receive` — the same one that lets
   * you post a stock receipt, because opening stock IS a receipt that happens to be typed from a
   * spreadsheet instead of a supplier's note.
   *
   * `commit = false` is a pure preview: the server validates every row and writes nothing, so the
   * operator approves exactly what a commit will do. A file with any bad row answers with the report
   * rather than an error status — the report is the resource they asked for.
   */
  @Post('opening-stock/import')
  @RequirePermissions('inventory.receive')
  async importOpeningStock(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = OpeningStockImportSchema.parse(body);
    return this.inventory.importOpeningStock(ctx.tenantId, ctx.userId, ctx.deviceId, req.correlationId, input);
  }

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

  /**
   * Cross-branch transfers this branch is party to (item 4.7): what it sent and is waiting on, and
   * what is waiting for it to count. There is deliberately no `POST` — a transfer is created and
   * counted through `/v1/sync/push` as a `StockTransfer` command, because that is the only write
   * path that queues offline and is idempotent under retry (§6).
   */
  @Get('transfers')
  @RequirePermissions('inventory.transfer')
  async transfers(@CurrentAuth() ctx: AuthContext, @Query() query: unknown) {
    const { branchId, limit } = TransfersQuerySchema.parse(query);
    return { transfers: await this.inventory.transfers(ctx.tenantId, branchId, ctx.deviceId, limit) };
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
