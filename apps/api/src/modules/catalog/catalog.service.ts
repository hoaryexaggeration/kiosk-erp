import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
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

@Injectable()
export class CatalogService {
  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
  ) {}

  async listProducts(tenantId: string, limit: number, offset: number, updatedSince?: string) {
    let query = this.dbs.db
      .selectFrom('products')
      .select(['id', 'sku', 'name', 'description', 'unit', 'is_stock_tracked', 'is_active', 'price_minor', 'cost_minor', 'version', 'updated_at'])
      .where('tenant_id', '=', tenantId)
      .where('deleted_at', 'is', null);
    if (updatedSince) query = query.where('updated_at', '>', new Date(updatedSince));
    const rows = await query.orderBy('sku', 'asc').limit(limit).offset(offset).execute();
    return { products: rows, limit, offset };
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

      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'product.created',
        aggregateType: 'Product',
        aggregateId: id,
        after: { sku: input.sku, name: input.name, priceMinor: input.priceMinor ?? 0 },
        correlationId,
      });
      await this.events.serverEvent(trx, {
        tenantId,
        eventType: 'product.created',
        aggregateType: 'Product',
        aggregateId: id,
        payload: { sku: input.sku, name: input.name, priceMinor: input.priceMinor ?? 0 },
      });
      await this.events.outbox(trx, tenantId, 'product.created', { productId: id });

      return trx.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  async lookupBarcode(tenantId: string, code: string) {
    const row = await this.dbs.db
      .selectFrom('barcodes')
      .innerJoin('products', 'products.id', 'barcodes.product_id')
      .select(['products.id', 'products.sku', 'products.name', 'products.price_minor'])
      .where('barcodes.tenant_id', '=', tenantId)
      .where('barcodes.barcode', '=', code)
      .executeTakeFirst();
    if (!row) throw AppError.notFound('BARCODE_NOT_FOUND', `No product for barcode ${code}`);
    return row;
  }

  /** Everything a device needs to operate offline (§6 local database responsibilities). */
  async configSnapshot(tenantId: string) {
    const [branches, taxCategories, license, numbering, head] = await Promise.all([
      this.dbs.db.selectFrom('branches').select(['id', 'code', 'name']).where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('tax_categories').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('licenses').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst(),
      this.dbs.db.selectFrom('numbering_series').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('server_events').select(({ fn }) => fn.max<number>('seq').as('max')).where('tenant_id', '=', tenantId).executeTakeFirst(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      schemaVersion: 1,
      branches,
      taxCategories,
      numberingSeries: numbering,
      license: license ?? null,
      serverCursor: Number(head?.max ?? 0),
    };
  }
}
