import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DbService } from '../../db/db.service';
import { Database } from '../../db/database';
import { EventsService } from '../platform/events.service';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { parseCsv } from '../../domain/csv';
import { UNIT_KINDS, UnitKind } from '../../domain/units';
import { ImportReferenceData, planProductImport, recordsToCsvRows } from './product-import';

/** PostgreSQL's unique_violation — the one error worth retrying an auto-generated SKU for. */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && String((err as { code?: unknown }).code) === '23505';

/**
 * One pack size of a product: `1 <unit> = <factor> <product's base unit>` (item 4.6). Devices
 * cache these so a crate converts offline, and the stock ledger only ever sees the base unit.
 */
export interface ProductConversion {
  unit: string;
  factor: number;
}

export interface CreateProductInput {
  id?: string;
  /** Blank or absent → the server takes the next free `SKU-\d+` (scan-to-add, v0.4.9). */
  sku?: string;
  name: string;
  description?: string;
  categoryId?: string;
  taxCategoryId?: string;
  brandId?: string | null;
  unit?: string;
  isStockTracked?: boolean;
  priceMinor?: number;
  costMinor?: number;
  /** Low-stock threshold in base units (item 4.9); null or absent means "no alert configured". */
  reorderPoint?: number | null;
  barcodes?: string[];
  /** The full desired conversion set; absent means "leave the stored set alone". */
  conversions?: ProductConversion[];
}

export interface UpdateProductInput {
  sku?: string;
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  taxCategoryId?: string | null;
  /** Explicit null clears the brand, exactly like `categoryId`. */
  brandId?: string | null;
  unit?: string;
  isStockTracked?: boolean;
  isActive?: boolean;
  priceMinor?: number;
  costMinor?: number;
  /** Low-stock threshold: null clears it, absent keeps the stored value (item 4.9). */
  reorderPoint?: number | null;
  /**
   * The full desired barcode set. When present the server replaces this product's barcodes with
   * exactly these values, so a barcode can be added or removed after the product exists — a new
   * product is no longer the only way to make an item scannable.
   */
  barcodes?: string[];
  /** The full desired conversion set. Same rule as barcodes: present means replace, absent means leave. */
  conversions?: ProductConversion[];
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
      .leftJoin('brands', 'brands.id', 'products.brand_id')
      .select([
        'products.id',
        'products.sku',
        'products.name',
        'products.description',
        'products.category_id',
        'products.tax_category_id',
        'products.brand_id',
        'products.unit',
        'products.price_minor',
        'products.cost_minor',
        'products.reorder_point',
        'products.is_stock_tracked',
        'products.is_active',
        'products.version',
        'tax_categories.rate_bp as tax_rate_bp',
        'tax_categories.inclusive as tax_inclusive',
        'brands.name as brand_name',
      ])
      .where('products.id', '=', productId)
      .where('products.tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const barcodes = await this.barcodesFor(trx, tenantId, [productId]);
    const conversions = await this.conversionsFor(trx, tenantId, [productId]);
    // The kind of the base unit rides WITH the pack sizes: a device converting a receipt while the
    // shop is offline needs the rule (`count` stays whole, a weigh may not) on the same payload that
    // brings the factor it is applying (item 4.6).
    const unitKind = await this.unitKindFor(trx, tenantId, row.unit);
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      description: row.description,
      category_id: row.category_id,
      // Without this a device editing a product would send `taxCategoryId: null` and silently
      // clear the product's tax rate.
      tax_category_id: row.tax_category_id,
      brand_id: row.brand_id,
      brand_name: row.brand_name ?? null,
      unit: row.unit,
      unit_kind: unitKind,
      price_minor: Number(row.price_minor),
      cost_minor: Number(row.cost_minor),
      // The threshold ships with the product (item 4.9): the device's Stock screen computes the
      // breach from cached balances while the shop is offline, so it needs this value locally.
      reorder_point: row.reorder_point === null ? null : Number(row.reorder_point),
      is_stock_tracked: row.is_stock_tracked,
      is_active: row.is_active,
      version: row.version,
      tax_rate_bp: row.tax_rate_bp ?? 0,
      tax_inclusive: row.tax_inclusive ?? false,
      barcodes: barcodes.get(productId) ?? [],
      conversions: conversions.get(productId) ?? [],
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

  /**
   * Pack sizes keyed by product id (item 4.6), ordered so a device caches them deterministically.
   * `factor` arrives from Postgres as a numeric string, so it is coerced exactly once, here.
   */
  private async conversionsFor(trx: Kysely<Database>, tenantId: string, productIds: string[]): Promise<Map<string, ProductConversion[]>> {
    const grouped = new Map<string, ProductConversion[]>();
    if (productIds.length === 0) return grouped;
    const rows = await trx
      .selectFrom('unit_conversions')
      .select(['product_id', 'unit', 'factor'])
      .where('tenant_id', '=', tenantId)
      .where('product_id', 'in', productIds)
      .orderBy('unit', 'asc')
      .execute();
    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push({ unit: row.unit, factor: Number(row.factor) });
      grouped.set(row.product_id, list);
    }
    return grouped;
  }

  async listProducts(tenantId: string, limit: number, offset: number, updatedSince?: string) {
    let query = this.dbs.db
      .selectFrom('products')
      .leftJoin('tax_categories', 'tax_categories.id', 'products.tax_category_id')
      .leftJoin('brands', 'brands.id', 'products.brand_id')
      .select([
        'products.id',
        'products.sku',
        'products.name',
        'products.description',
        'products.category_id',
        'products.tax_category_id',
        'products.brand_id',
        'products.unit',
        'products.is_stock_tracked',
        'products.is_active',
        'products.price_minor',
        'products.cost_minor',
        'products.reorder_point',
        'products.version',
        'products.updated_at',
        'tax_categories.rate_bp as tax_rate_bp',
        'tax_categories.inclusive as tax_inclusive',
        'brands.name as brand_name',
      ])
      .where('products.tenant_id', '=', tenantId)
      .where('products.deleted_at', 'is', null);
    if (updatedSince) query = query.where('products.updated_at', '>', new Date(updatedSince));
    const rows = await query.orderBy('products.sku', 'asc').limit(limit).offset(offset).execute();
    const barcodes = await this.barcodesFor(this.dbs.db, tenantId, rows.map((r) => r.id));
    const conversions = await this.conversionsFor(this.dbs.db, tenantId, rows.map((r) => r.id));
    const unitKinds = await this.unitKindsFor(this.dbs.db, tenantId);
    return {
      products: rows.map((row) => ({
        ...row,
        brand_name: row.brand_name ?? null,
        // Null when the product's unit is not in the vocabulary — a device must be able to tell
        // "no rule" from "counted", never invent one (item 4.6).
        unit_kind: unitKinds.get(String(row.unit).trim().toLowerCase()) ?? null,
        barcodes: barcodes.get(row.id) ?? [],
        conversions: conversions.get(row.id) ?? [],
      })),
      limit,
      offset,
    };
  }

  async createProduct(tenantId: string, actorId: string, correlationId: string, input: CreateProductInput) {
    const id = input.id ?? newId();
    // A blank SKU means "name this one for me" (scan-to-add, v0.4.9): the number is generated INSIDE
    // the transaction from what this tenant already holds, and a UNIQUE (tenant, sku) violation from
    // a concurrent create — two tills saving the same instant — is retried with the next number
    // rather than surfaced: both tills end up with a product, neither with a confusing error.
    const requestedSku = input.sku?.trim() ?? '';
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.dbs.transaction(async (trx) => {
          const sku = requestedSku || (await this.nextSku(trx, tenantId));
          const dup = await trx.selectFrom('products').select('id').where('tenant_id', '=', tenantId).where('sku', '=', sku).executeTakeFirst();
          if (dup) throw AppError.conflict('DUPLICATE_SKU', `SKU ${sku} already exists`);

          if (input.categoryId) await this.assertTenanted(trx, tenantId, 'categories', input.categoryId, 'UNKNOWN_CATEGORY');
          if (input.taxCategoryId) await this.assertTenanted(trx, tenantId, 'tax_categories', input.taxCategoryId, 'UNKNOWN_TAX_CATEGORY');
          if (input.brandId) await this.assertTenanted(trx, tenantId, 'brands', input.brandId, 'UNKNOWN_BRAND');

          const unit = input.unit ?? 'ea';
          // Validated before anything is written: a product with a pack size it could never convert is
          // a product whose next receipt would land in the wrong unit (item 4.6).
          const conversions = await this.validateConversions(trx, tenantId, unit, input.conversions ?? []);

          await trx
            .insertInto('products')
            .values({
              id,
              tenant_id: tenantId,
              sku,
              name: input.name,
              description: input.description ?? null,
              category_id: input.categoryId ?? null,
              tax_category_id: input.taxCategoryId ?? null,
              brand_id: input.brandId ?? null,
              unit,
              is_stock_tracked: input.isStockTracked ?? true,
              price_minor: input.priceMinor ?? 0,
              cost_minor: input.costMinor ?? 0,
              reorder_point: input.reorderPoint ?? null,
            })
            .execute();

          await this.replaceBarcodes(trx, tenantId, id, input.barcodes ?? []);
          // Absent means "no conversions wanted", which is exactly an empty set on a new product.
          if (input.conversions !== undefined) await this.writeConversions(trx, tenantId, id, conversions);

          return this.recordProductChange(trx, tenantId, actorId, correlationId, 'product.created', id);
        });
      } catch (err) {
        // Only the generated path can be helped by trying again, and only a few times: a repeated
        // violation means something else owns the number pattern, not that we guessed badly.
        if (requestedSku || attempt >= 2 || !isUniqueViolation(err)) throw err;
      }
    }
  }

  /**
   * The next free `SKU-<zero-padded number>` for this tenant: existing SKUs are the only input, so a
   * shop that has never used the pattern starts at `SKU-001` and one that already sells under
   * `SKU-0420` continues from there. Non-conforming SKUs (`PH4-NEW-1`, `BREAD`) are ignored rather
   * than tripped over — they are not part of the sequence (scan-to-add, v0.4.9).
   */
  private async nextSku(trx: Kysely<Database>, tenantId: string): Promise<string> {
    const rows = await trx
      .selectFrom('products')
      .select('sku')
      .where('tenant_id', '=', tenantId)
      .where('sku', 'like', 'SKU-%')
      .execute();
    let max = 0;
    let width = 3;
    for (const row of rows) {
      const match = /^SKU-(\d+)$/.exec(row.sku);
      if (!match) continue;
      const value = Number(match[1]);
      if (value > max) {
        max = value;
        width = match[1].length;
      }
    }
    return `SKU-${String(max + 1).padStart(width, '0')}`;
  }

  /**
   * Conversion sets are replaced, never merged — the same rule as barcodes (item 4.1): what the
   * caller sent is exactly what this product converts from, so a pack size can be retired by
   * sending a set without it.
   *
   * Every factor is checked against the tenant's unit catalogue and the product's BASE unit:
   * `1 crate = 24 ea` is only knowable if "crate" exists and "ea" is a real, typed unit — a
   * conversion to something the ledger does not hold stock in would silently invent quantity.
   */
  private async validateConversions(
    trx: Kysely<Database>,
    tenantId: string,
    baseUnit: string,
    requested: ProductConversion[],
  ): Promise<ProductConversion[]> {
    const desired = new Map<string, ProductConversion>();
    for (const entry of requested) {
      const unit = String(entry?.unit ?? '').trim();
      if (unit.length === 0) throw new AppError('UNKNOWN_UNIT', 'A conversion needs a unit', 400);
      if (unit.length > 16) throw new AppError('UNKNOWN_UNIT', `Unit "${unit}" may be at most 16 characters`, 400);
      desired.set(unit.toLowerCase(), { unit, factor: Number(entry.factor) });
    }
    if (desired.size === 0) return [];

    const base = baseUnit.trim().toLowerCase();
    const known = new Map(
      (await trx.selectFrom('units_of_measure').select(['code', 'kind']).where('tenant_id', '=', tenantId).execute()).map((u) => [
        u.code.toLowerCase(),
        u,
      ]),
    );

    if (!known.has(base)) {
      throw new AppError(
        'UNKNOWN_UNIT',
        `Selling unit "${baseUnit}" is not in this shop's unit catalogue. Add it under Units before giving the product pack sizes.`,
        400,
      );
    }
    for (const entry of desired.values()) {
      const key = entry.unit.toLowerCase();
      if (key === base) {
        throw new AppError(
          'SELF_CONVERSION',
          `A pack size of "${entry.unit}" would convert into itself — the selling unit is already ${baseUnit}`,
          400,
        );
      }
      if (!known.has(key)) {
        throw new AppError('UNKNOWN_UNIT', `Unknown unit "${entry.unit}" — add it under Units before converting to it`, 400);
      }
      if (!Number.isFinite(entry.factor) || entry.factor <= 0) {
        throw new AppError('INVALID_FACTOR', `How many ${baseUnit} make one ${entry.unit}? That number must be more than zero`, 400);
      }
    }
    return [...desired.values()];
  }

  /** Replace the stored conversion set in one go, inside the caller's transaction. */
  private async writeConversions(trx: Kysely<Database>, tenantId: string, productId: string, entries: ProductConversion[]) {
    await trx.deleteFrom('unit_conversions').where('tenant_id', '=', tenantId).where('product_id', '=', productId).execute();
    for (const entry of entries) {
      await trx
        .insertInto('unit_conversions')
        .values({ tenant_id: tenantId, product_id: productId, unit: entry.unit, factor: entry.factor })
        .execute();
    }
  }

  /**
   * The barcode set is replaced, never merged (item 4.1). A barcode belongs to one tenant exactly
   * once, so a clash with a *different* product is a conflict the operator must resolve, not a
   * barcode we quietly reassign.
   */
  private async replaceBarcodes(trx: Kysely<Database>, tenantId: string, productId: string, requested: string[]) {
    const desired = [...new Set(requested.map((barcode) => barcode.trim()).filter((barcode) => barcode.length > 0))];
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

  /** One product change is one audit entry, one server event and one outbox nudge — always together. */
  private async recordProductChange(
    trx: Kysely<Database>,
    tenantId: string,
    actorId: string,
    correlationId: string,
    action: 'product.created' | 'product.updated',
    productId: string,
    before?: unknown,
  ) {
    const after = await this.productPayload(trx, tenantId, productId);
    await this.events.audit(trx, {
      tenantId,
      actorId,
      action,
      aggregateType: 'Product',
      aggregateId: productId,
      before,
      after,
      correlationId,
    });
    await this.events.serverEvent(trx, { tenantId, eventType: action, aggregateType: 'Product', aggregateId: productId, payload: after });
    await this.events.outbox(trx, tenantId, action, { productId });
    return after;
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
      // A cleared or blank SKU keeps the product's own: an edit that empties the field is not a
      // rename to nothing, and a padded one is the same SKU with the spaces trimmed off.
      const requestedSku = input.sku?.trim();
      if (requestedSku && requestedSku !== current.sku) {
        const dup = await trx.selectFrom('products').select('id').where('tenant_id', '=', tenantId).where('sku', '=', requestedSku).executeTakeFirst();
        if (dup) throw AppError.conflict('DUPLICATE_SKU', `SKU ${requestedSku} already exists`);
      }

      const nextUnit = input.unit ?? current.unit;
      const unitChanged = nextUnit !== current.unit;
      if (input.categoryId) await this.assertTenanted(trx, tenantId, 'categories', input.categoryId, 'UNKNOWN_CATEGORY');
      if (input.taxCategoryId) await this.assertTenanted(trx, tenantId, 'tax_categories', input.taxCategoryId, 'UNKNOWN_TAX_CATEGORY');
      if (input.brandId) await this.assertTenanted(trx, tenantId, 'brands', input.brandId, 'UNKNOWN_BRAND');
      // The pack sizes must still make sense against the NEW base unit: retargeting a product from
      // `ea` to `crate` while it converts `crate -> ea` would leave a conversion that converts the
      // unit into itself. Validate whatever will be stored, whether or not this call sent a set.
      const desiredConversions =
        input.conversions ??
        (unitChanged ? ((await this.conversionsFor(trx, tenantId, [productId])).get(productId) ?? []) : null);
      const conversions = desiredConversions === null ? null : await this.validateConversions(trx, tenantId, nextUnit, desiredConversions);

      const before = await this.productPayload(trx, tenantId, productId);
      await trx
        .updateTable('products')
        .set({
          sku: requestedSku || current.sku,
          name: input.name ?? current.name,
          description: input.description === undefined ? current.description : input.description,
          category_id: input.categoryId === undefined ? current.category_id : input.categoryId,
          tax_category_id: input.taxCategoryId === undefined ? current.tax_category_id : input.taxCategoryId,
          brand_id: input.brandId === undefined ? current.brand_id : input.brandId,
          unit: nextUnit,
          is_stock_tracked: input.isStockTracked ?? current.is_stock_tracked,
          is_active: input.isActive ?? current.is_active,
          price_minor: input.priceMinor ?? current.price_minor,
          cost_minor: input.costMinor ?? current.cost_minor,
          // Absent keeps, explicit null clears — the same rule the brand and category follow.
          reorder_point: input.reorderPoint === undefined ? current.reorder_point : input.reorderPoint,
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', productId)
        .execute();

      // Replace the barcode set when the caller supplied one (item 4.1).
      if (input.barcodes !== undefined) await this.replaceBarcodes(trx, tenantId, productId, input.barcodes);
      // Same rule for conversions: present means replace (item 4.6).
      if (conversions !== null) await this.writeConversions(trx, tenantId, productId, conversions);

      return this.recordProductChange(trx, tenantId, actorId, correlationId, 'product.updated', productId, before);
    });
  }

  /**
   * Bulk catalogue import (item 4.4): parse -> plan -> optionally apply.
   *
   * Preview and commit share ONE planner, so the report the operator approves is exactly the report a
   * commit acts on. A commit with any invalid row writes nothing at all: a half-imported catalogue is
   * worse than a rejected file, because nobody can then tell which half is real.
   */
  async importProducts(
    tenantId: string,
    actorId: string,
    correlationId: string,
    input: {
      csv?: string;
      records?: unknown[];
      commit: boolean;
      createMissingCategories: boolean;
      createMissingBrands: boolean;
    },
  ) {
    const parsed = input.csv !== undefined ? parseCsv(input.csv) : recordsToCsvRows(input.records ?? []);
    const reference = await this.importReference(tenantId);
    const plan = planProductImport(parsed, reference, {
      createMissingCategories: input.createMissingCategories,
      createMissingBrands: input.createMissingBrands,
    });

    const report = {
      status: (plan.errors.length > 0 ? 'invalid' : input.commit ? 'committed' : 'validated') as 'invalid' | 'committed' | 'validated',
      rowCount: Math.max(parsed.length - 1, 0),
      validCount: plan.rows.length,
      errorCount: plan.errors.length,
      createCount: plan.createCount,
      updateCount: plan.updateCount,
      categoriesToCreate: plan.categoriesToCreate,
      brandsToCreate: plan.brandsToCreate,
      errors: plan.errors,
      previewTruncated: plan.rows.length > 100,
      preview: plan.rows.slice(0, 100).map((row) => ({
        line: row.line,
        action: row.action,
        sku: row.sku,
        name: row.name,
        category: row.categoryName,
        brand: row.brandName,
        unit: row.unit,
        priceMinor: row.priceMinor,
        costMinor: row.costMinor,
        barcodes: row.barcodes,
      })),
    };

    // The guard above is the whole point: invalid or preview-only never reaches a write.
    if (!input.commit || plan.errors.length > 0) return report;

    await this.dbs.transaction(async (trx) => {
      const categoryIdByName = new Map([...reference.categoriesByName].map(([key, value]) => [key, value.id] as const));
      for (const name of plan.categoriesToCreate) {
        const id = newId();
        await trx.insertInto('categories').values({ id, tenant_id: tenantId, name, parent_id: null }).execute();
        categoryIdByName.set(name.toLowerCase(), id);
        await this.events.audit(trx, {
          tenantId,
          actorId,
          action: 'category.created',
          aggregateType: 'Category',
          aggregateId: id,
          after: { name, source: 'import' },
          correlationId,
        });
      }

      const brandIdByName = new Map([...reference.brandsByName].map(([key, value]) => [key, value.id] as const));
      for (const name of plan.brandsToCreate) {
        const id = newId();
        await trx.insertInto('brands').values({ id, tenant_id: tenantId, name }).execute();
        brandIdByName.set(name.toLowerCase(), id);
        await this.events.audit(trx, {
          tenantId,
          actorId,
          action: 'brand.created',
          aggregateType: 'Brand',
          aggregateId: id,
          after: { name, source: 'import' },
          correlationId,
        });
      }

      for (const row of plan.rows) {
        const categoryId = row.categoryName ? categoryIdByName.get(row.categoryName.toLowerCase()) ?? null : null;
        const brandId = row.brandName ? brandIdByName.get(row.brandName.toLowerCase()) ?? null : null;
        if (row.action === 'create') {
          const id = newId();
          await trx
            .insertInto('products')
            .values({
              id,
              tenant_id: tenantId,
              sku: row.sku,
              name: row.name,
              description: row.description,
              category_id: categoryId,
              tax_category_id: row.taxCategoryId,
              brand_id: brandId,
              unit: row.unit,
              is_stock_tracked: row.isStockTracked,
              is_active: row.isActive,
              price_minor: row.priceMinor,
              cost_minor: row.costMinor,
              reorder_point: row.reorderPoint ?? null,
            })
            .execute();
          if (row.barcodes) await this.replaceBarcodes(trx, tenantId, id, row.barcodes);
          await this.recordProductChange(trx, tenantId, actorId, correlationId, 'product.created', id);
        } else {
          if (!row.productId) throw new Error('import planner produced an update without a product id');
          const before = await this.productPayload(trx, tenantId, row.productId);
          await trx
            .updateTable('products')
            .set({
              // The file is the desired state of the columns it carries, category, brand and tax rate
              // included: a file with no `brand` column clears the brand exactly as it clears the
              // category. The barcode column is the one exception: when the file has no barcode
              // column at all, the stored set is left alone rather than wiped because someone
              // omitted a column (see PlannedProductRow.barcodes). The threshold follows the SAME
              // carve-out: a file that never carried `reorder_point` must not wipe thresholds
              // somebody set by hand, while a blank CELL in a present column clears one.
              sku: row.sku,
              name: row.name,
              description: row.description,
              category_id: categoryId,
              tax_category_id: row.taxCategoryId,
              brand_id: brandId,
              unit: row.unit,
              is_stock_tracked: row.isStockTracked,
              is_active: row.isActive,
              price_minor: row.priceMinor,
              cost_minor: row.costMinor,
              reorder_point: row.reorderPoint === undefined ? before.reorder_point : row.reorderPoint,
              version: Number((before as { version?: number }).version ?? 1) + 1,
              updated_at: new Date(),
            })
            .where('id', '=', row.productId)
            .where('tenant_id', '=', tenantId)
            .execute();
          if (row.barcodes) await this.replaceBarcodes(trx, tenantId, row.productId, row.barcodes);
          await this.recordProductChange(trx, tenantId, actorId, correlationId, 'product.updated', row.productId, before);
        }
      }

      // One line for the batch itself, so the audit trail shows the file that caused the changes even
      // after the individual product events have been read individually.
      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'catalog.imported',
        aggregateType: 'ProductImport',
        aggregateId: correlationId,
        after: {
          createCount: plan.createCount,
          updateCount: plan.updateCount,
          categoriesCreated: plan.categoriesToCreate,
          brandsCreated: plan.brandsToCreate,
          source: input.csv !== undefined ? 'csv' : 'records',
        },
        correlationId,
      });
    });

    return report;
  }

  /**
   * A snapshot of what the file must be resolved against. One query per table rather than a lookup per
   * row: an import of a few thousand rows must not become a few thousand round-trips.
   */
  private async importReference(tenantId: string): Promise<ImportReferenceData> {
    const [products, barcodes, taxCategories, categories, brands] = await Promise.all([
      this.dbs.db.selectFrom('products').select(['id', 'sku']).where('tenant_id', '=', tenantId).where('deleted_at', 'is', null).execute(),
      this.dbs.db.selectFrom('barcodes').select(['barcode', 'product_id']).where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('tax_categories').select(['id', 'name']).where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('categories').select(['id', 'name']).where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('brands').select(['id', 'name']).where('tenant_id', '=', tenantId).execute(),
    ]);

    // SKUs are matched ignoring case (a shopkeeper writes "milk-1l" and "MILK-1L" meaning one product).
    // Postgres' unique index is case-sensitive, so two products may legitimately differ only by case;
    // such an SKU is reported as ambiguous rather than updating whichever row was read first.
    const productIdBySku = new Map<string, string>();
    const ambiguousSkus = new Set<string>();
    for (const product of products) {
      const key = product.sku.toLowerCase();
      if (ambiguousSkus.has(key)) continue;
      if (productIdBySku.has(key)) {
        productIdBySku.delete(key);
        ambiguousSkus.add(key);
        continue;
      }
      productIdBySku.set(key, product.id);
    }

    return {
      productIdBySku,
      ambiguousSkus,
      barcodeOwner: new Map(barcodes.map((row) => [row.barcode, row.product_id])),
      taxCategoriesByName: new Map(taxCategories.map((row) => [row.name.toLowerCase(), { id: row.id, name: row.name }])),
      categoriesByName: new Map(categories.map((row) => [row.name.toLowerCase(), { id: row.id, name: row.name }])),
      brandsByName: new Map(brands.map((row) => [row.name.toLowerCase(), { id: row.id, name: row.name }])),
    };
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

  /**
   * A UUID is not proof of tenancy (§9): before a product points at reference data, that data must
   * belong to THIS tenant. Brands arrive with item 4.6, but categories and tax rates are written
   * through the same two endpoints, so all three are checked the same way.
   */
  private async assertTenanted(
    trx: Kysely<Database>,
    tenantId: string,
    table: 'categories' | 'brands' | 'tax_categories',
    id: string,
    code: string,
  ): Promise<void> {
    const found = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM ${sql.table(table)} WHERE id = ${id} AND tenant_id = ${tenantId}
      ) AS exists
    `.execute(trx);
    if (!found.rows[0]?.exists) throw AppError.notFound(code, 'That record does not belong to this shop');
  }

  // --- units of measure (item 4.6) --------------------------------------------------------------

  /**
   * The `kind` of a product's base unit (`count`, `weight`, `volume`), or null when that unit is not
   * in the shop's vocabulary. Shipped on the product payload because the conversion rule belongs to
   * the product's pack sizes: a device must be able to tell a crate count that has to land whole
   * from a weigh that need not, on the same pull that brings the factors, without the network (§6).
   */
  private async unitKindFor(db: Kysely<Database>, tenantId: string, unit: string): Promise<string | null> {
    const row = await db
      .selectFrom('units_of_measure')
      .select('kind')
      .where('tenant_id', '=', tenantId)
      .where(sql<string>`lower(code)`, '=', unit.trim().toLowerCase())
      .executeTakeFirst();
    return row?.kind ?? null;
  }

  /** Every base-unit kind for a tenant, keyed by lower-cased code: one query for a page of products. */
  private async unitKindsFor(db: Kysely<Database>, tenantId: string): Promise<Map<string, string>> {
    const rows = await db.selectFrom('units_of_measure').select(['code', 'kind']).where('tenant_id', '=', tenantId).execute();
    return new Map(rows.map((row) => [row.code.toLowerCase(), row.kind]));
  }

  /**
   * The unit catalogue: the vocabulary a quantity may be written in, and — through `kind` — what the
   * ledger will accept for the product's base unit (`count` stays whole, `weight`/`volume` may not).
   */
  async listUnits(tenantId: string) {
    const units = await this.dbs.db
      .selectFrom('units_of_measure')
      .select(['id', 'code', 'name', 'kind', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .orderBy('code', 'asc')
      .execute();
    return { units };
  }

  async createUnit(tenantId: string, actorId: string, correlationId: string, input: { id?: string; code: string; name: string; kind: string }) {
    const code = input.code.trim().toLowerCase();
    const name = input.name.trim();
    if (code.length === 0) throw new AppError('INVALID_UNIT', 'A unit needs a short code such as ea, kg or crate', 400);
    if (!UNIT_KINDS.includes(input.kind as UnitKind)) {
      throw new AppError('UNKNOWN_UNIT_KIND', `Kind must be one of: ${UNIT_KINDS.join(', ')}`, 400);
    }
    const existing = await this.dbs.db.selectFrom('units_of_measure').select('code').where('tenant_id', '=', tenantId).execute();
    if (existing.some((u) => u.code.toLowerCase() === code)) {
      throw AppError.conflict('DUPLICATE_UNIT', `Unit "${code}" already exists`);
    }

    const id = input.id ?? newId();
    return this.dbs.transaction(async (trx) => {
      await trx
        .insertInto('units_of_measure')
        .values({ id, tenant_id: tenantId, code, name, kind: input.kind })
        .execute();
      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'unit.created',
        aggregateType: 'UnitOfMeasure',
        aggregateId: id,
        after: { code, name, kind: input.kind },
        correlationId,
      });
      return trx.selectFrom('units_of_measure').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  // --- brands (§3.C product master, item 4.6) ---------------------------------------------------

  async listBrands(tenantId: string) {
    const brands = await this.dbs.db
      .selectFrom('brands')
      .select(['id', 'name', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .orderBy('name', 'asc')
      .execute();
    return { brands };
  }

  async createBrand(tenantId: string, actorId: string, correlationId: string, input: { id?: string; name: string }) {
    const name = input.name.trim();
    if (name.length === 0) throw new AppError('INVALID_BRAND', 'A brand needs a name', 400);
    const existing = await this.dbs.db.selectFrom('brands').select('name').where('tenant_id', '=', tenantId).execute();
    // "Coca" and "COCA" are one brand to a shopkeeper, so the check ignores case just as the
    // unique index behind it does.
    if (existing.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      throw AppError.conflict('DUPLICATE_BRAND', `Brand "${name}" already exists`);
    }

    const id = input.id ?? newId();
    return this.dbs.transaction(async (trx) => {
      await trx.insertInto('brands').values({ id, tenant_id: tenantId, name }).execute();
      await this.events.audit(trx, {
        tenantId,
        actorId,
        action: 'brand.created',
        aggregateType: 'Brand',
        aggregateId: id,
        after: { name },
        correlationId,
      });
      return trx.selectFrom('brands').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  /** Everything a device needs to operate offline (§6 local database responsibilities). */
  async configSnapshot(tenantId: string) {
    const [branches, taxCategories, categories, units, brands, license, numbering, head] = await Promise.all([
      this.dbs.db.selectFrom('branches').select(['id', 'code', 'name']).where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('tax_categories').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('categories').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('units_of_measure').selectAll().where('tenant_id', '=', tenantId).execute(),
      this.dbs.db.selectFrom('brands').selectAll().where('tenant_id', '=', tenantId).execute(),
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
      units,
      brands,
      numberingSeries: numbering,
      license: license ?? null,
      serverCursor: Number(head?.max ?? 0),
    };
  }
}
