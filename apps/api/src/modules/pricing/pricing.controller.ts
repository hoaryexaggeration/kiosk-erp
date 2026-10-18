import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthContext, CurrentAuth } from '../../common/auth-context';
import { DbService } from '../../db/db.service';
import { PricingService } from './pricing.service';
import { AppError } from '../../common/errors';

@Controller('pricing')
export class PricingController {
  constructor(
    private readonly dbs: DbService,
    private readonly pricing: PricingService,
  ) {}

  /** Resolve the price a device should show, optionally as of a past instant. */
  @Get('resolve')
  async resolve(
    @CurrentAuth() ctx: AuthContext,
    @Query('productId') productId?: string,
    @Query('quantity') quantity?: string,
    @Query('asOf') asOf?: string,
  ) {
    const parsed = z.string().uuid().safeParse(productId);
    if (!parsed.success) throw AppError.validation('productId must be a UUID');
    const at = asOf ? new Date(asOf) : new Date();
    if (Number.isNaN(at.getTime())) throw AppError.validation('asOf is not a valid timestamp');
    const resolved = await this.pricing.resolvePrice(this.dbs.db, ctx.tenantId, parsed.data, Number(quantity ?? 1) || 1, at);
    if (!resolved) throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
    return resolved;
  }
}
