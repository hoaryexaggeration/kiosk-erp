import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DbService } from '../../db/db.service';
import { Database } from '../../db/database';
import { EventsService } from '../platform/events.service';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';

export interface CreateProductInput {
  id?: string;
  sku: string;
  name: string;
  description?: string;
  categoryId?: string;
  taxCategoryId?: string;
  unit?: string;
  isStockTracked?: boolean;
  priceMinor?: number;
  costMinor?: number;
  barcodes?: string[];
}

export interface UpdateProductInput {
  sku?: string;
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  taxCategoryId?: string | null;
  unit?: string;
  isStockTracked?: boolean;
  isActive?: boolean;
  priceMinor?: number;
  costMinor?: number;
  /**
   * The full desired barcode set. When present the server replaces this product's barcodes with
   * exactly these values, so a barcode can be added or removed after the product exists — a new
   * product is no longer the only way to make an item scannable.
   */
  barcodes?: string[];
  expectedVersion?: number;
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
  ) {}

  /** The exact shape devices cache and that server events carry (keys match the client DTO). */
  private async productPayload(trx: Kysely<Database>, tenantId: string, productId: string) {
    const row = await trx
      .selectFrom('products')
      .leftJoin('tax_categories', 'tax_categories.id', 'products.tax_category_id')
      .select([
        'products.id',
        'products.sku',
        'products.name',
        'products.description',
        'products.category_id',
        'products.tax_category_id',
        'products.unit',
        'products.price_minor',
        'products.cost_minor',
        'products.is_stock_tracked',
        'products.is_active',
        'products.version',
        'tax_categories.rate_bp as tax_rate_bp',
        'tax_categories.inclusive as tax_inclusive',
      ])
      .where('products.id', '=', productId)
      .where('products.tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const barcodes = await this.barcodesFor(trx, tenantId, [productId]);
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      description: row.description,
      category_id: row.category_id,
      // Without this a device editing a product would send `taxCategoryId: null` and silently
      // clear the product's tax rate.
      tax_category_id: row.tax_category_id,
      unit: row.unit,
      price_minor: Number(row.price_minor),
      cost_minor: Number(row.cost_minor),
      is_stock_tracked: row.is_stock_tracked,
      is_active: row.is_active,
      version: row.version,
      tax_rate_bp: row.tax_rate_bp ?? 0,
      tax_inclusive: row.tax_inclusive ?? false,
      barcodes: barcodes.get(productId) ?? [],
    };
  }

  /**
   * Barcodes keyed by product id. Devices cache these so a scan resolves offline (§6); the scan
   * path must never depend on the network.
   */
  private async barcodesFor(trx: Kysely<Database>, tenantId: string, productIds: string[]): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>();
    if (productIds.length === 0) return grouped;
    const rows = await trx
      .selectFrom('barcodes')
      .select(['product_id', 'barcode'])
      .where('tenant_id', '=', tenantId)
      .where('product_id', 'in', productIds)
      .orderBy('barcode', 'asc')
      .execute();
    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push(row.barcode);
      grouped.set(row.product_id, list);
    }
    return grouped;
  }

  async listProducts(tenantId: string, limit: number, offset: number, updatedSince?: string) {
    let query = this.dbs.db
      .selectFrom('products')
      .leftJoin('tax_categories', 'tax_categories.id', 'products.tax_category_id')
      .select([
        'products.id',
        'products.sku',
        'products.name',
        'products.description',
        'products.category_id',
        'products.tax_category_id',
        'products.unit',
        'products.is_stock_tracked',
        'products.is_active',
        'products.price_minor',
        'products.cost_minor',
        'products.version',
        'products.updated_at',
        'tax_categories.rate_bp as tax_rate_bp',
        'tax_categories.inclusive as tax_inclusive',
      ])
      .where('products.tenant_id', '=', tenantId)
      .where('products.deleted_at', 'is', null);
    if (updatedSince) query = query.where('products.updated_at', '>', new Date(updatedSince));
    const rows = await query.orderBy('products.sku', 'asc').limit(limit).offset(offset).execute();
    const barcodes = await this.barcodesFor(this.dbs.db, tenantId, rows.map((r) => r.id));
    return {
      products: rows.map((row) => ({ ...row, barcodes: barcodes.get(row.id) ?? [] })),
      limit,
      offset,
    };
  }

  async createProduct(tenantId: string, actorId: string, correlationId: string, input: CreateProductInput) {
    const id = input.id ?? newId();
    return this.dbs.transaction(async (trx) => {
      const dup = await trx.selectFrom('products').select('id').where('tenant_id', '=', tenantId).where('sku', '=', input.sku).executeTakeFirst();
      if (dup) throw AppError.conflict('DUPLICATE_SKU', `SKU ${input.sku} already exists`);

      await trx
        .insertInto('products')
        .values({
          id,
          tenant_id: tenantId,
          sku: input.sku,
          name: input.name,
          description: input.description ?? null,
          category_id: input.categoryId ?? null,
          tax_category_id: input.taxCategoryId ?? null,
          unit: input.unit ?? 'ea',
          is_stock_tracked: input.isStockTracked ?? true,
          price_minor: input.priceMinor ?? 0,
          cost_minor: input.costMinor ?? 0,
        })
        .execute();

      for (const barcode of input.barcodes ?? []) {
        await trx.insertInto('barcodes').values({ tenant_id: tenantId, product_id: id, barcode }).onConflict((oc) => oc.columns(['tenant_id', 'barcode']).doNothing()).execute();
      }

      const payload = await this.productPayload(trx, tenantId, id);
      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'product.created',
        aggregateType: 'Product',
        aggregateId: id,
        after: payload,
        correlationId,
      });
      await this.events.serverEvent(trx, {
        tenantId,
        eventType: 'product.created',
        aggregateType: 'Product',
        aggregateId: id,
        payload,
      });
      await this.events.outbox(trx, tenantId, 'product.created', { productId: id });

      return payload;
    });
  }

  /** Optimistic-concurrency update. Bumps `version`; devices merge on the new version. */
  async updateProduct(tenantId: string, actorId: string, correlationId: string, productId: string, input: UpdateProductInput) {
    return this.dbs.transaction(async (trx) => {
      const current = await trx
        .selectFrom('products')
        .selectAll()
        .where('id', '=', productId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!current || current.deleted_at) throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');

      if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
        throw AppError.conflict('VERSION_MISMATCH', `Expected version ${input.expectedVersion} but found ${current.version}`);
      }
      if (input.sku && input.sku !== current.sku) {
        const dup = await trx.selectFrom('products').select('id').where('tenant_id', '=', tenantId).where('sku', '=', input.sku).executeTakeFirst();
        if (dup) throw AppError.conflict('DUPLICATE_SKU', `SKU ${input.sku} already exists`);
      }

      const before = await this.productPayload(trx, tenantId, productId);
      await trx
        .updateTable('products')
        .set({
          sku: input.sku ?? current.sku,
          name: input.name ?? current.name,
          description: input.description === undefined ? current.description : input.description,
          category_id: input.categoryId === undefined ? current.category_id : input.categoryId,
          tax_category_id: input.taxCategoryId === undefined ? current.tax_category_id : input.taxCategoryId,
          unit: input.unit ?? current.unit,
          is_stock_tracked: input.isStockTracked ?? current.is_stock_tracked,
          is_active: input.isActive ?? current.is_active,
          price_minor: input.priceMinor ?? current.price_minor,
          cost_minor: input.costMinor ?? current.cost_minor,
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', productId)
        .execute();

      // Replace the barcode set when the caller supplied one (item 4.1). A barcode belongs to one
      // tenant exactly once, so a clash with a *different* product is a conflict, not a silent move.
      if (input.barcodes !== undefined) {
        const desired = [...new Set(input.barcodes.map((b) => b.trim()).filter((b) => b.length > 0))];
        if (desired.length > 0) {
          const clash = await trx
            .selectFrom('barcodes')
            .select(['barcode', 'product_id'])
            .where('tenant_id', '=', tenantId)
            .where('barcode', 'in', desired)
            .where('product_id', '!=', productId)
            .executeTakeFirst();
          if (clash) throw AppError.conflict('DUPLICATE_BARCODE', `Barcode ${clash.barcode} already belongs to another product`);
        }
        const stale = trx.deleteFrom('barcodes').where('tenant_id', '=', tenantId).where('product_id', '=', productId);
        if (desired.length > 0) {
          await stale.where('barcode', 'not in', desired).execute();
        } else {
          await stale.execute();
        }
        for (const barcode of desired) {
          await trx
            .insertInto('barcodes')
            .values({ tenant_id: tenantId, product_id: productId, barcode })
            .onConflict((oc) => oc.columns(['tenant_id', 'barcode']).doNothing())
            .execute();
        }
      }

      const after = await this.productPayload(trx, tenantId, productId);
      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'product.updated',
        aggregateType: 'Product',
        aggregateId: productId,
        before,
        after,
        correlationId,
      });
      await this.events.serverEvent(trx, {
        tenantId,
        eventType: 'product.updated',
        aggregateType: 'Product',
        aggregateId: productId,
        payload: after,
      });
      await this.events.outbox(trx, tenantId, 'product.updated', { productId });
      return after;
    });
  }

  async lookupBarcode(tenantId: string, code: string) {
    const row = await this.dbs.db
      .selectFrom('barcodes')
      .innerJoin('products', 'products.id', 'barcodes.product_id')
      .leftJoin('tax_categories', 'tax_categories.id', 'products.tax_category_id')
      .select([
        'products.id',
        'products.sku',
        'products.name',
        'products.price_minor',
        'tax_categories.rate_bp as tax_rate_bp',
        'tax_categories.inclusive as tax_inclusive',
      ])
      .where('barcodes.tenant_id', '=', tenantId)
      .where('barcodes.barcode', '=', code)
      .executeTakeFirst();
    if (!row) throw AppError.notFound('BARCODE_NOT_FOUND', `No product for barcode ${code}`);
    return row;
  }

  async listTaxCategories(tenantId: string) {
    return { taxCategories: await this.dbs.db.selectFrom('tax_categories').selectAll().where('tenant_id', '=', tenantId).execute() };
  }

  async createTaxCategory(tenantId: string, actorId: string, correlationId: string, input: { id?: string; name: string; rateBp: number; inclusive: boolean }) {
    const id = input.id ?? newId();
    return this.dbs.transaction(async (trx) => {
      await trx
        .insertInto('tax_categories')
        .values({ id, tenant_id: tenantId, name: input.name, rate_bp: input.rateBp, inclusive: input.inclusive })
        .execute();
      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'tax_category.created',
        aggregateType: 'TaxCategory',
        aggregateId: id,
        after: { name: input.name, rateBp: input.rateBp, inclusive: input.inclusive },
        correlationId,
      });
      return trx.selectFrom('tax_categories').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  async listCategories(tenantId: string) {
    return { categories: await this.dbs.db.selectFrom('categories').selectAll().where('tenant_id', '=', tenantId).execute() };
  }

  async createCategory(tenantId: string, actorId: string, correlationId: string, input: { id?: string; name: string; parentId?: string }) {
    const id = input.id ?? newId();
    return this.dbs.transaction(async (trx) => {
      await trx.insertInto('categories').values({ id, tenant_id: tenantId, name: input.name, parent_id: input.parentId ?? null }).execute();
      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'category.created',
        aggregateType: 'Category',
        aggregateId: id,
        after: { name: input.name },
        correlationId,
      });
      return trx.selectFrom('categories').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  /** Everything a device needs to operate offline (§6 local database responsibilities). */
  async configSnapshot(tenantId: string) {
    const [branches, taxCategories, categories, license, numbering, head] = await Promise.all([
      this.dbs.db.selectFrom('branches').select(['id', 'code', 'name']).where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('tax_categories').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('categories').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('licenses').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst(),
      this.dbs.db.selectFrom('numbering_series').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('server_events').select(({ fn }) => fn.max<number>('seq').as('max')).where('tenant_id', '=', tenantId).executeTakeFirst(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      schemaVersion: 1,
      branches,
      taxCategories,
      categories,
      numberingSeries: numbering,
      license: license ?? null,
      serverCursor: Number(head?.max ?? 0),
    };
  }
}
