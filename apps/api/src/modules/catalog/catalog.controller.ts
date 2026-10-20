import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { CatalogService } from './catalog.service';
import { AuthContext, AuthedRequest, CurrentAuth, RequirePermissions } from '../../common/auth-context';

/**
 * Pack sizes (item 4.6): `1 <unit> = <factor> <product's base unit>`. The factor itself is checked
 * against the tenant's unit catalogue in the service — a schema cannot know which units exist.
 */
const ConversionSetSchema = z
  .array(
    z.object({
      unit: z.string().min(1).max(16),
      factor: z.number().finite().positive(),
    }),
  )
  .max(50);

const CreateProductSchema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  categoryId: z.string().uuid().optional(),
  taxCategoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().nullable().optional(),
  unit: z.string().max(16).optional(),
  isStockTracked: z.boolean().optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  costMinor: z.number().int().nonnegative().optional(),
  barcodes: z.array(z.string().min(1).max(64)).max(20).optional(),
  /** `1 <unit> = <factor> <unit>` pack sizes (item 4.6); absent means "no conversions". */
  conversions: ConversionSetSchema.optional(),
});

const UpdateProductSchema = z.object({
  sku: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  taxCategoryId: z.string().uuid().nullable().optional(),
  brandId: z.string().uuid().nullable().optional(),
  unit: z.string().max(16).optional(),
  isStockTracked: z.boolean().optional(),
  isActive: z.boolean().optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  costMinor: z.number().int().nonnegative().optional(),
  /** The full desired barcode set for this product; the server replaces what is stored. */
  barcodes: z.array(z.string().min(1).max(64)).max(20).optional(),
  /** The full desired conversion set; the server replaces what is stored. Absent leaves it alone. */
  conversions: ConversionSetSchema.optional(),
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

/**
 * A unit of measure (item 4.6). `kind` is what the ledger cares about: a `count` base unit must
 * stay whole, `weight` and `volume` may be fractional.
 */
const UnitSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(60),
  kind: z.enum(['count', 'weight', 'volume']),
});

/** A brand (§3.C product master). Names are unique per tenant ignoring case. */
const BrandSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
});

/**
 * Bulk import. `csv` or `records` (not both); `commit: false` is a pure preview. A file with any bad
 * row is reported, not partially applied — see CatalogService.importProducts.
 */
const ProductImportSchema = z
  .object({
    csv: z.string().max(5_000_000).optional(),
    records: z.array(z.unknown()).max(5000).optional(),
    commit: z.boolean().default(false),
    createMissingCategories: z.boolean().default(false),
    /** Brands are labels, not money — but they are still created only when asked for (item 4.6). */
    createMissingBrands: z.boolean().default(false),
  })
  .refine((value) => (value.csv === undefined) !== (value.records === undefined), {
    message: 'Provide exactly one of csv or records',
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

  /**
   * Bulk catalogue import (item 4.4). A rejected file answers with the per-row error report rather
   * than an error status: the report IS the resource the operator asked for, and a preview that found
   * problems is a successful preview, not a failed request. Nothing is written unless `commit` is true
   * AND every row is valid.
   */
  @Post('products/import')
  @RequirePermissions('catalog.manage')
  async import(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = ProductImportSchema.parse(body);
    return this.catalog.importProducts(ctx.tenantId, ctx.userId, req.correlationId, input);
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

  /** Unit catalogue (item 4.6). Reading it is not a privileged act; adding one is. */
  @Get('units')
  async units(@CurrentAuth() ctx: AuthContext) {
    return this.catalog.listUnits(ctx.tenantId);
  }

  @Post('units')
  @RequirePermissions('catalog.manage')
  async createUnit(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = UnitSchema.parse(body);
    return this.catalog.createUnit(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  /** Brands a product can belong to (§3.C product master, item 4.6). */
  @Get('brands')
  async brands(@CurrentAuth() ctx: AuthContext) {
    return this.catalog.listBrands(ctx.tenantId);
  }

  @Post('brands')
  @RequirePermissions('catalog.manage')
  async createBrand(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = BrandSchema.parse(body);
    return this.catalog.createBrand(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Get('config/snapshot')
  async snapshot(@CurrentAuth() ctx: AuthContext) {
    return this.catalog.configSnapshot(ctx.tenantId);
  }
}
