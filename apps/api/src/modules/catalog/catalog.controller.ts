import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
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

const UpdateProductSchema = z.object({
  sku: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  taxCategoryId: z.string().uuid().nullable().optional(),
  unit: z.string().max(16).optional(),
  isStockTracked: z.boolean().optional(),
  isActive: z.boolean().optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  costMinor: z.number().int().nonnegative().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

const TaxCategorySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  rateBp: z.number().int().min(0).max(10000),
  inclusive: z.boolean(),
});

const CategorySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  parentId: z.string().uuid().optional(),
});

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  async list(
    @CurrentAuth() ctx: AuthContext,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('updatedSince') updatedSince?: string,
  ) {
    return this.catalog.listProducts(ctx.tenantId, Math.min(Number(limit ?? 100) || 100, 500), Math.max(Number(offset ?? 0) || 0, 0), updatedSince);
  }

  @Post('products')
  @RequirePermissions('catalog.manage')
  async create(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = CreateProductSchema.parse(body);
    return this.catalog.createProduct(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Patch('products/:id')
  @RequirePermissions('catalog.manage')
  async update(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = UpdateProductSchema.parse(body);
    return this.catalog.updateProduct(ctx.tenantId, ctx.userId, req.correlationId, id, input);
  }

  @Get('barcodes/:code')
  async barcode(@CurrentAuth() ctx: AuthContext, @Param('code') code: string) {
    return this.catalog.lookupBarcode(ctx.tenantId, code);
  }

  @Get('tax-categories')
  async taxCategories(@CurrentAuth() ctx: AuthContext) {
    return this.catalog.listTaxCategories(ctx.tenantId);
  }

  @Post('tax-categories')
  @RequirePermissions('catalog.manage')
  async createTaxCategory(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = TaxCategorySchema.parse(body);
    return this.catalog.createTaxCategory(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Get('categories')
  async categories(@CurrentAuth() ctx: AuthContext) {
    return this.catalog.listCategories(ctx.tenantId);
  }

  @Post('categories')
  @RequirePermissions('catalog.manage')
  async createCategory(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = CategorySchema.parse(body);
    return this.catalog.createCategory(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Get('config/snapshot')
  async snapshot(@CurrentAuth() ctx: AuthContext) {
    return this.catalog.configSnapshot(ctx.tenantId);
  }
}
