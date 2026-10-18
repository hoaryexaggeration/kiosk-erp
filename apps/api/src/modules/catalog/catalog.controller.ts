import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { CatalogService } from './catalog.service';
import { AuthContext, AuthedRequest, CurrentAuth, RequirePermissions } from '../../common/auth-context';

const CreateProductSchema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  categoryId: z.string().uuid().optional(),
  taxCategoryId: z.string().uuid().optional(),
  unit: z.string().max(16).optional(),
  isStockTracked: z.boolean().optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  costMinor: z.number().int().nonnegative().optional(),
  barcodes: z.array(z.string().min(1).max(64)).max(20).optional(),
});

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  async list(@CurrentAuth() ctx: AuthContext, @Query('limit') limit?: string, @Query('offset') offset?: string, @Query('updatedSince') updatedSince?: string) {
    return this.catalog.listProducts(ctx.tenantId, Math.min(Number(limit ?? 100) || 100, 500), Math.max(Number(offset ?? 0) || 0, 0), updatedSince);
  }

  @Post('products')
  @RequirePermissions('catalog.manage')
  async create(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = CreateProductSchema.parse(body);
    return this.catalog.createProduct(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Get('barcodes/:code')
  async barcode(@CurrentAuth() ctx: AuthContext, @Param('code') code: string) {
    return this.catalog.lookupBarcode(ctx.tenantId, code);
  }

  @Get('config/snapshot')
  async snapshot(@CurrentAuth() ctx: AuthContext) {
    return this.catalog.configSnapshot(ctx.tenantId);
  }
}
