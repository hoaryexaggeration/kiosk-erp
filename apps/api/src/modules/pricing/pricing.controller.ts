import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthContext, CurrentAuth, RequirePermissions } from '../../common/auth-context';
import { DbService } from '../../db/db.service';
import { PricingService } from './pricing.service';
import { AppError } from '../../common/errors';

const CreateOverrideSchema = z.object({
  productId: z.string().uuid(),
  /** Absent or null = the tenant-wide list; a UUID narrows the row to that shelf (item 4.11). */
  branchId: z.string().uuid().nullable().optional(),
  priceMinor: z.number().int().nonnegative(),
  /** ISO timestamps; `validFrom` is inclusive, `validTo` exclusive, null = open-ended. */
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }).nullable().optional(),
});

const UpdateOverrideSchema = z.object({
  branchId: z.string().uuid().nullable().optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  validFrom: z.string().datetime({ offset: true }).optional(),
  validTo: z.string().datetime({ offset: true }).nullable().optional(),
});

@Controller('pricing')
export class PricingController {
  constructor(
    private readonly dbs: DbService,
    private readonly pricing: PricingService,
  ) {}

  /**
   * Resolve the price a device should show, optionally as of a past instant and for a named
   * branch — the branch is stated explicitly because the same catalogue legitimately prices two
   * shelves differently (item 4.11).
   */
  @Get('resolve')
  async resolve(
    @CurrentAuth() ctx: AuthContext,
    @Query('productId') productId?: string,
    @Query('quantity') quantity?: string,
    @Query('asOf') asOf?: string,
    @Query('branchId') branchId?: string,
  ) {
    const parsed = z.string().uuid().safeParse(productId);
    if (!parsed.success) throw AppError.validation('productId must be a UUID');
    const branch = branchId ? z.string().uuid().safeParse(branchId) : null;
    if (branch && !branch.success) throw AppError.validation('branchId must be a UUID');
    const at = asOf ? new Date(asOf) : new Date();
    if (Number.isNaN(at.getTime())) throw AppError.validation('asOf is not a valid timestamp');
    const resolved = await this.pricing.resolvePrice(
      this.dbs.db,
      ctx.tenantId,
      parsed.data,
      Number(quantity ?? 1) || 1,
      at,
      branch?.data ?? null,
    );
    if (!resolved) throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
    return resolved;
  }

  /** One product's price lists, newest window first (item 4.11). */
  @Get('overrides')
  async overrides(@CurrentAuth() ctx: AuthContext, @Query('productId') productId?: string) {
    const parsed = z.string().uuid().safeParse(productId);
    if (!parsed.success) throw AppError.validation('productId must be a UUID');
    const rows = await this.pricing.listOverrides(this.dbs.db, ctx.tenantId, parsed.data);
    return { overrides: rows };
  }

  @Post('overrides')
  @RequirePermissions('catalog.manage')
  async createOverride(@CurrentAuth() ctx: AuthContext, @Body() body: unknown) {
    const parsed = CreateOverrideSchema.safeParse(body);
    if (!parsed.success) throw AppError.validation('Invalid price override');
    const id = await this.pricing.createOverride(this.dbs.db, ctx.tenantId, ctx.userId, {
      productId: parsed.data.productId,
      branchId: parsed.data.branchId ?? null,
      priceMinor: parsed.data.priceMinor,
      validFrom: new Date(parsed.data.validFrom),
      validTo: parsed.data.validTo ? new Date(parsed.data.validTo) : null,
    });
    return { id };
  }

  @Patch('overrides/:id')
  @RequirePermissions('catalog.manage')
  async updateOverride(@CurrentAuth() ctx: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    const parsed = UpdateOverrideSchema.safeParse(body);
    if (!parsed.success) throw AppError.validation('Invalid price override');
    await this.pricing.updateOverride(this.dbs.db, ctx.tenantId, ctx.userId, id, {
      branchId: parsed.data.branchId,
      priceMinor: parsed.data.priceMinor,
      validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : undefined,
      validTo: parsed.data.validTo === undefined ? undefined : parsed.data.validTo ? new Date(parsed.data.validTo) : null,
    });
    return { ok: true };
  }

  @Delete('overrides/:id')
  @RequirePermissions('catalog.manage')
  async deleteOverride(@CurrentAuth() ctx: AuthContext, @Param('id') id: string) {
    await this.pricing.deleteOverride(this.dbs.db, ctx.tenantId, ctx.userId, id);
    return { ok: true };
  }

  /** Who changed which price, when (item 4.11, §3.C "price change history"). */
  @Get('history')
  @RequirePermissions('catalog.manage')
  async history(@CurrentAuth() ctx: AuthContext, @Query('productId') productId?: string, @Query('limit') limit?: string) {
    const parsed = z.string().uuid().safeParse(productId);
    if (!parsed.success) throw AppError.validation('productId must be a UUID');
    const capped = Math.min(Math.max(Number(limit ?? 100) || 100, 1), 200);
    const rows = await this.pricing.history(this.dbs.db, ctx.tenantId, parsed.data, capped);
    return { history: rows };
  }
}
