import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/database';
import { DbService } from '../../db/db.service';
import { EventsService } from '../platform/events.service';
import { OpeningStockImportInput, StockAdjustmentPayload, StockReceiptPayload } from './inventory.schema';
import { AppError } from '../../common/errors';
import { parseCsv } from '../../domain/csv';
import {
  OpeningStockIssue,
  OpeningStockProduct,
  OpeningStockReference,
  planOpeningStockImport,
  recordsToCsvRows,
} from './opening-stock-import';
import { roundHalfUp } from '../../domain/pricing';

export interface InventoryContext {
  tenantId: string;
  branchId: string;
  deviceId: string;
  actorId: string;
  commandId: string;
  correlationId: string;
}

export interface ApplyMovement {
  tenantId: string;
  branchId: string;
  locationId: string;
  productId: string;
  quantityDelta: number;
  unit?: string;
  reason: string;
  sourceType: string;
  sourceId?: string | null;
  actorId?: string | null;
  deviceId?: string | null;
  commandId?: string | null;
  approvedBy?: string | null;
  approvalNote?: string | null;
  /** Inbound only: the cost that opens a FIFO valuation layer (ADR 0009). */
  unitCostMinor?: number;
}

export interface MovementResult {
  /** Resulting on-hand quantity (derived projection). */
  quantity: number;
  /** FIFO cost consumed by an outbound movement; 0 for inbound. */
  cogsMinor: number;
  /** Outbound quantity with no layer to draw on — i.e. stock went negative. */
  uncostedQuantity: number;
}

/** Normalised outcome of applying an inventory aggregate through the sync command path. */
export interface ApplyResult {
  status: 'accepted' | 'review_required' | 'rejected';
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
  conflictCodes?: string[];
}

const DEFAULT_LOCATION_NAME = 'Store';

/** How many planned lines the report carries before it is truncated — enough to review, bounded. */
const OPENING_PREVIEW_LIMIT = 100;

/** One planned line as it goes back to the operator: the quantity that was and the quantity that will be. */
export interface OpeningStockPreviewRow {
  line: number;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  onHandBefore: number;
  onHandAfter: number;
  unitCostMinor: number;
  valueMinor: number;
  costWasGiven: boolean;
}

/**
 * The result of an opening-stock import. A file with errors answers with this report rather than an
 * error status: a preview that found problems is a successful preview, not a failed request.
 * `invalid` means nothing was written; `alreadyApplied` means a retried commit found its own
 * movements and left them alone.
 */
export interface OpeningStockReport {
  status: 'invalid' | 'validated' | 'committed';
  alreadyApplied: boolean;
  rowCount: number;
  validCount: number;
  errorCount: number;
  warningCount: number;
  totalQuantity: number;
  totalValueMinor: number;
  errors: OpeningStockIssue[];
  warnings: OpeningStockIssue[];
  previewTruncated: boolean;
  preview: OpeningStockPreviewRow[];
}

/**
 * The single write path for on-hand stock. Movements are append-only facts; the balance table is a
 * derived projection. Nothing here uses "last write wins" on quantity (§6, §7).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
  ) {}

  /** Returns the branch's default stock location, creating it once if absent. */
  async getOrCreateLocation(trx: Kysely<Database>, tenantId: string, branchId: string): Promise<string> {
    const existing = await trx
      .selectFrom('stock_locations')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('branch_id', '=', branchId)
      .executeTakeFirst();
    if (existing) return existing.id;
    const row = await trx
      .insertInto('stock_locations')
      .values({ tenant_id: tenantId, branch_id: branchId, name: DEFAULT_LOCATION_NAME, kind: 'store' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Current on-hand for a product at a location (derived projection, never authoritative). */
  async onHand(trx: Kysely<Database>, tenantId: string, branchId: string, locationId: string, productId: string): Promise<number> {
    const row = await trx
      .selectFrom('stock_balances')
      .select('quantity')
      .where('tenant_id', '=', tenantId)
      .where('branch_id', '=', branchId)
      .where('location_id', '=', locationId)
      .where('product_id', '=', productId)
      .executeTakeFirst();
    return Number(row?.quantity ?? 0);
  }

  /**
   * The single write path for on-hand stock. Appends the movement fact, updates the derived
   * balance, and applies FIFO valuation (ADR 0009): a receipt opens a cost layer; an issue
   * consumes the oldest open layers and records exactly what it cost.
   *
   * A movement is never withheld to preserve a fact — if an issue outruns the available layers the
   * movement still stands and `uncostedQuantity` reports the shortfall so the caller can raise a
   * visible exception (the till blocks it up front; the server preserves the evidence).
   */
  async applyMovement(trx: Kysely<Database>, m: ApplyMovement): Promise<MovementResult> {
    const movementId = crypto.randomUUID();
    await trx
      .insertInto('inventory_movements')
      .values({
        id: movementId,
        tenant_id: m.tenantId,
        branch_id: m.branchId,
        location_id: m.locationId,
        product_id: m.productId,
        quantity_delta: m.quantityDelta,
        unit: m.unit ?? 'ea',
        reason: m.reason,
        source_type: m.sourceType,
        source_id: m.sourceId ?? null,
        actor_id: m.actorId ?? null,
        device_id: m.deviceId ?? null,
        command_id: m.commandId ?? null,
        approved_by: m.approvedBy ?? null,
        approval_note: m.approvalNote ?? null,
        cogs_minor: null,
      })
      .execute();

    const row = await sql<{ quantity: number }>`
      INSERT INTO stock_balances (tenant_id, branch_id, location_id, product_id, quantity, updated_at)
      VALUES (${m.tenantId}, ${m.branchId}, ${m.locationId}, ${m.productId}, ${m.quantityDelta}, now())
      ON CONFLICT (tenant_id, branch_id, location_id, product_id)
      DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
      RETURNING quantity
    `.execute(trx);
    const quantity = Number(row.rows[0]?.quantity ?? 0);

    let cogsMinor = 0;
    let uncostedQuantity = 0;

    if (m.quantityDelta > 0) {
      // Inbound opens a layer at the stated cost (0 when genuinely unknown; the receipt path
      // substitutes the last known purchase cost so stock is never silently valued at zero).
      await trx
        .insertInto('inventory_valuation_layers')
        .values({
          id: crypto.randomUUID(),
          tenant_id: m.tenantId,
          branch_id: m.branchId,
          location_id: m.locationId,
          product_id: m.productId,
          source_movement_id: movementId,
          unit_cost_minor: m.unitCostMinor ?? 0,
          quantity_received: m.quantityDelta,
          quantity_remaining: m.quantityDelta,
        })
        .execute();
    } else if (m.quantityDelta < 0) {
      let needed = -m.quantityDelta;
      const layers = await trx
        .selectFrom('inventory_valuation_layers')
        .select(['id', 'unit_cost_minor', 'quantity_remaining'])
        .where('tenant_id', '=', m.tenantId)
        .where('branch_id', '=', m.branchId)
        .where('location_id', '=', m.locationId)
        .where('product_id', '=', m.productId)
        .where('quantity_remaining', '>', 0)
        .orderBy('received_at', 'asc')
        .orderBy('id', 'asc')
        .execute();

      for (const layer of layers) {
        if (needed <= 0) break;
        const available = Number(layer.quantity_remaining);
        const take = Math.min(available, needed);
        if (take <= 0) continue;
        const unitCost = Number(layer.unit_cost_minor);
        const amount = roundHalfUp(take * unitCost);
        await trx
          .updateTable('inventory_valuation_layers')
          .set({ quantity_remaining: available - take })
          .where('id', '=', layer.id)
          .execute();
        await trx
          .insertInto('inventory_cost_allocations')
          .values({
            id: crypto.randomUUID(),
            tenant_id: m.tenantId,
            movement_id: movementId,
            layer_id: layer.id,
            quantity: take,
            unit_cost_minor: unitCost,
            amount_minor: amount,
          })
          .execute();
        cogsMinor += amount;
        needed -= take;
      }
      uncostedQuantity = needed > 0 ? needed : 0;
      if (cogsMinor !== 0) {
        // Derived cost is filled in within the same transaction that recorded the fact; the
        // quantity/reason/actor fields of a movement are never rewritten.
        await trx.updateTable('inventory_movements').set({ cogs_minor: cogsMinor }).where('id', '=', movementId).execute();
      }
    }

    return { quantity, cogsMinor, uncostedQuantity };
  }

  /** Remaining value of open FIFO layers for one product at one location. */
  async layerValue(trx: Kysely<Database>, tenantId: string, branchId: string, locationId: string, productId: string): Promise<number> {
    const row = await sql<{ value_minor: string }>`
      SELECT COALESCE(SUM(quantity_remaining * unit_cost_minor), 0) AS value_minor
      FROM inventory_valuation_layers
      WHERE tenant_id = ${tenantId} AND branch_id = ${branchId}
        AND location_id = ${locationId} AND product_id = ${productId}
        AND quantity_remaining > 0
    `.execute(trx);
    return Math.round(Number(row.rows[0]?.value_minor ?? 0));
  }

  /** Stock receipt (GRN): increase on-hand and open a FIFO valuation layer per line (ADR 0009). */
  async receiveStock(trx: Kysely<Database>, ctx: InventoryContext, payload: StockReceiptPayload): Promise<ApplyResult> {
    const receipt = payload.receipt;
    const locationId = receipt.locationId ?? (await this.getOrCreateLocation(trx, ctx.tenantId, ctx.branchId));
    let totalValueMinor = 0;

    for (const line of receipt.lines) {
      const product = await trx
        .selectFrom('products')
        .select(['id', 'sku', 'cost_minor', 'unit', 'deleted_at'])
        .where('id', '=', line.productId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!product || product.deleted_at) continue;

      // Without an explicit cost the last known purchase cost is used, so a receipt always opens a
      // costed layer (ADR 0009) rather than silently valuing incoming stock at zero.
      const unitCostMinor = line.unitCostMinor ?? Number(product.cost_minor);

      await this.applyMovement(trx, {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId,
        productId: line.productId,
        quantityDelta: line.quantity,
        unit: line.unit ?? product.unit,
        reason: receipt.reason,
        sourceType: 'stock_receipt',
        sourceId: receipt.id,
        actorId: ctx.actorId,
        deviceId: ctx.deviceId,
        commandId: ctx.commandId,
        unitCostMinor,
      });

      if (line.unitCostMinor !== undefined) {
        // `products.cost_minor` is retained only as the latest known purchase cost (display and the
        // fallback layer cost above); valuation itself is entirely layer-based.
        await trx.updateTable('products').set({ cost_minor: line.unitCostMinor, updated_at: new Date() }).where('id', '=', line.productId).execute();
      }
      totalValueMinor += roundHalfUp(line.quantity * unitCostMinor);
    }

    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'stock.received',
      aggregateType: 'StockReceipt',
      aggregateId: receipt.id,
      after: { lineCount: receipt.lines.length, totalValueMinor },
      correlationId: ctx.correlationId,
    });
    const seq = await this.events.serverEvent(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      eventType: 'stock.received',
      aggregateType: 'StockReceipt',
      aggregateId: receipt.id,
      payload: { lineCount: receipt.lines.length, reference: receipt.reference ?? null },
    });
    await this.events.outbox(trx, ctx.tenantId, 'stock.received', { receiptId: receipt.id });

    return { status: 'accepted' as const, result: { receiptId: receipt.id, serverSeq: seq } };
  }

  /** Stock adjustment: audited, reason-required, and never silently negative (ADR 0009). */
  async adjustStock(trx: Kysely<Database>, ctx: InventoryContext, payload: StockAdjustmentPayload): Promise<ApplyResult> {
    const adjustment = payload.adjustment;
    const locationId = adjustment.locationId ?? (await this.getOrCreateLocation(trx, ctx.tenantId, ctx.branchId));
    let negative = false;
    let uncosted = false;

    // Validate every line before writing a single movement: a partially applied adjustment must
    // never commit. A negative adjustment needs an explicit supervisor override note.
    if (!adjustment.approvalNote) {
      for (const line of adjustment.lines) {
        if (line.quantityDelta >= 0) continue;
        const available = await this.onHand(trx, ctx.tenantId, ctx.branchId, locationId, line.productId);
        if (available + line.quantityDelta < 0) {
          return {
            status: 'rejected' as const,
            code: 'OVERRIDE_REQUIRED',
            message: `Adjustment would take ${line.productId} below zero; a supervisor override note is required`,
            conflictCodes: ['NEGATIVE_STOCK'],
          };
        }
      }
    }

    for (const line of adjustment.lines) {
      const product = await trx
        .selectFrom('products')
        .select(['id', 'unit'])
        .where('id', '=', line.productId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!product) continue;
      const movement = await this.applyMovement(trx, {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId,
        productId: line.productId,
        quantityDelta: line.quantityDelta,
        unit: line.unit ?? product.unit,
        reason: adjustment.reason,
        sourceType: 'stock_adjustment',
        sourceId: adjustment.id,
        actorId: ctx.actorId,
        deviceId: ctx.deviceId,
        commandId: ctx.commandId,
        approvedBy: adjustment.approvedBy ?? null,
        approvalNote: adjustment.approvalNote ?? null,
      });
      if (movement.quantity < 0) negative = true;
      if (movement.uncostedQuantity > 0) uncosted = true;
    }

    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'stock.adjusted',
      aggregateType: 'StockAdjustment',
      aggregateId: adjustment.id,
      reason: adjustment.reason,
      after: { lineCount: adjustment.lines.length },
      correlationId: ctx.correlationId,
    });
    const seq = await this.events.serverEvent(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      eventType: 'stock.adjusted',
      aggregateType: 'StockAdjustment',
      aggregateId: adjustment.id,
      payload: { reason: adjustment.reason, negative, uncosted },
    });
    await this.events.outbox(trx, ctx.tenantId, 'stock.adjusted', { adjustmentId: adjustment.id });

    const reviewRequired = negative || uncosted;
    return {
      status: reviewRequired ? ('review_required' as const) : ('accepted' as const),
      result: { adjustmentId: adjustment.id, serverSeq: seq, negative, uncosted },
      conflictCodes: reviewRequired ? ['NEGATIVE_STOCK'] : [],
    };
  }

  /**
   * Opening-stock import (item 4.5): a preview/commit pair over one pure planner.
   *
   * Opening balances arrive ONLY as movements. `applyMovement` appends a fact and the balance
   * projection follows — nothing here can set a quantity — which is the exit criterion for this
   * item: an opening balance is an event that happened on a date, it is auditable, and it opens the
   * FIFO layers that value everything which later sells (ADR 0009).
   *
   * All-or-nothing: the plan is fully decided before the transaction opens, so an invalid file never
   * reaches a write, and a failure inside the transaction rolls back every movement — a half-imported
   * opening balance cannot exist.
   */
  async importOpeningStock(
    tenantId: string,
    actorId: string,
    deviceId: string | undefined,
    correlationId: string,
    input: OpeningStockImportInput,
  ): Promise<OpeningStockReport> {
    // Another tenant's branch is a leak, not a row-level problem, so it fails the whole request.
    const branch = await this.dbs.db
      .selectFrom('branches')
      .select('id')
      .where('id', '=', input.branchId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!branch) throw AppError.notFound('UNKNOWN_BRANCH', 'That branch does not belong to this tenant');

    // A preview must write nothing, so it never creates the stock location. Without a location there
    // are no balances to read, and for a branch that is being opened "nothing recorded" IS zero —
    // which is the truth rather than an approximation of it.
    const locationId = await this.findLocation(tenantId, input.branchId);
    const reference = await this.openingStockReference(tenantId, input.branchId, locationId);
    const parsed = input.csv !== undefined ? parseCsv(input.csv) : recordsToCsvRows(input.records ?? []);
    const plan = planOpeningStockImport(parsed, reference);

    const report: OpeningStockReport = {
      status: (plan.errors.length > 0 ? 'invalid' : input.commit ? 'committed' : 'validated') as OpeningStockReport['status'],
      alreadyApplied: false,
      rowCount: Math.max(parsed.length - 1, 0),
      validCount: plan.rows.length,
      errorCount: plan.errors.length,
      warningCount: plan.warnings.length,
      totalQuantity: plan.totalQuantity,
      totalValueMinor: plan.totalValueMinor,
      errors: plan.errors,
      warnings: plan.warnings,
      previewTruncated: plan.rows.length > OPENING_PREVIEW_LIMIT,
      preview: plan.rows.slice(0, OPENING_PREVIEW_LIMIT).map((row) => ({
        line: row.line,
        sku: row.sku,
        name: row.name,
        unit: row.unit,
        quantity: row.quantity,
        onHandBefore: row.onHandBefore,
        onHandAfter: row.onHandAfter,
        unitCostMinor: row.unitCostMinor,
        valueMinor: row.valueMinor,
        costWasGiven: row.costWasGiven,
      })),
    };

    // The guard above is the whole point: invalid or preview-only never reaches a write.
    if (!input.commit || plan.errors.length > 0) return report;

    // One file chosen once is one identity for both preview and commit, so a commit that timed out
    // and is retried reports "already applied" instead of opening a second lot of stock. The ledger's
    // own unique index on (tenant, command) is the backstop if two identical requests ever race.
    const applied = await this.dbs.db
      .selectFrom('inventory_movements')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('command_id', '=', input.requestId)
      .executeTakeFirst();
    if (applied) return { ...report, status: 'committed', alreadyApplied: true };

    await this.dbs.transaction(async (trx) => {
      // Only the write path creates the location; the preview resolved it read-only above.
      const commitLocationId = locationId ?? (await this.getOrCreateLocation(trx, tenantId, input.branchId));

      for (const row of plan.rows) {
        await this.applyMovement(trx, {
          tenantId,
          branchId: input.branchId,
          locationId: commitLocationId,
          productId: row.productId,
          quantityDelta: row.quantity,
          unit: row.unit,
          reason: 'opening',
          sourceType: 'opening_stock',
          sourceId: input.requestId,
          actorId,
          deviceId,
          commandId: input.requestId,
          unitCostMinor: row.unitCostMinor,
        });

        // `products.cost_minor` is the latest known purchase cost and a display fallback (ADR 0009
        // keeps valuation layer-based). It moves only when the file stated a cost — an omitted cost
        // must not rewrite what the buyer already recorded for the product.
        if (row.costWasGiven) {
          await trx.updateTable('products').set({ cost_minor: row.unitCostMinor, updated_at: new Date() }).where('id', '=', row.productId).execute();
        }
      }

      await this.events.audit(trx, {
        tenantId,
        branchId: input.branchId,
        actorId,
        deviceId,
        action: 'opening_stock.imported',
        aggregateType: 'StockOpening',
        aggregateId: input.requestId,
        after: {
          lineCount: plan.rows.length,
          totalQuantity: plan.totalQuantity,
          totalValueMinor: plan.totalValueMinor,
          warningCount: plan.warnings.length,
        },
        correlationId,
      });
      // Deliberately no server event and no outbox row: this is a management action run on the
      // server rather than a command from a device, and every device already refetches the whole
      // balance projection on its next sync — the event would be written with no reader.
    });

    return report;
  }

  /** The branch's existing default location, WITHOUT creating one — a preview must write nothing. */
  private async findLocation(tenantId: string, branchId: string): Promise<string | null> {
    const row = await this.dbs.db
      .selectFrom('stock_locations')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('branch_id', '=', branchId)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /**
   * Everything the planner needs, read once outside the transaction. Balances are loaded for the
   * whole branch rather than only the SKUs in the file: the planner never queries, so it stays a
   * pure function, and a superette's single-branch balance table is small enough to read whole.
   */
  private async openingStockReference(tenantId: string, branchId: string, locationId: string | null): Promise<OpeningStockReference> {
    const db = this.dbs.db;
    const [products, balances, openings, trading] = await Promise.all([
      db
        .selectFrom('products')
        .select(['id', 'sku', 'name', 'unit', 'cost_minor', 'is_stock_tracked'])
        .where('tenant_id', '=', tenantId)
        .where('deleted_at', 'is', null)
        .execute(),
      locationId
        ? db
            .selectFrom('stock_balances')
            .select(['product_id', 'quantity'])
            .where('tenant_id', '=', tenantId)
            .where('branch_id', '=', branchId)
            .where('location_id', '=', locationId)
            .execute()
        : Promise.resolve([]),
      db
        .selectFrom('inventory_movements')
        .select('product_id')
        .where('tenant_id', '=', tenantId)
        .where('branch_id', '=', branchId)
        .where('source_type', '=', 'opening_stock')
        .execute(),
      db
        .selectFrom('inventory_movements')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('branch_id', '=', branchId)
        .where('source_type', '!=', 'opening_stock')
        .limit(1)
        .executeTakeFirst(),
    ]);

    const productsBySku = new Map<string, OpeningStockProduct>();
    const skuCounts = new Map<string, number>();
    for (const row of products) {
      const key = row.sku.toLowerCase();
      skuCounts.set(key, (skuCounts.get(key) ?? 0) + 1);
      // First wins; an SKU that exists more than once (case variants pass the unique index) is
      // reported as ambiguous instead of letting this import pick one of them arbitrarily.
      if (productsBySku.has(key)) continue;
      productsBySku.set(key, {
        id: row.id,
        sku: row.sku,
        name: row.name,
        unit: row.unit,
        costMinor: Number(row.cost_minor),
        isStockTracked: row.is_stock_tracked,
      });
    }

    const onHandByProduct = new Map<string, number>();
    for (const balance of balances) onHandByProduct.set(balance.product_id, Number(balance.quantity));

    return {
      productsBySku,
      ambiguousSkus: new Set([...skuCounts].filter(([, count]) => count > 1).map(([key]) => key)),
      onHandByProduct,
      productsWithOpening: new Set(openings.map((row) => row.product_id)),
      branchAlreadyTrading: trading !== undefined,
    };
  }

  async balances(tenantId: string, branchId?: string, limit = 200) {
    let query = this.dbs.db
      .selectFrom('stock_balances')
      .innerJoin('products', 'products.id', 'stock_balances.product_id')
      .select([
        'stock_balances.product_id',
        'products.sku',
        'products.name',
        'stock_balances.branch_id',
        'stock_balances.quantity',
        'stock_balances.updated_at',
      ])
      .where('stock_balances.tenant_id', '=', tenantId)
      .orderBy('products.name', 'asc');
    if (branchId) query = query.where('stock_balances.branch_id', '=', branchId);
    return query.limit(Math.min(limit, 500)).execute();
  }

  /**
   * Stock value per product from the open FIFO layers (ADR 0009). Value is derived, never stored:
   * it is exactly the sum of what remains in the layers minus what has already been consumed.
   */
  async valuation(tenantId: string, branchId?: string, limit = 200) {
    const result = await sql<{
      product_id: string;
      sku: string;
      name: string;
      branch_id: string;
      quantity_remaining: string;
      value_minor: string;
    }>`
      SELECT l.product_id, p.sku, p.name, l.branch_id,
             SUM(l.quantity_remaining) AS quantity_remaining,
             SUM(l.quantity_remaining * l.unit_cost_minor) AS value_minor
      FROM inventory_valuation_layers l
      JOIN products p ON p.id = l.product_id
      WHERE l.tenant_id = ${tenantId}
        AND l.quantity_remaining > 0
        ${branchId ? sql`AND l.branch_id = ${branchId}` : sql``}
      GROUP BY l.product_id, p.sku, p.name, l.branch_id
      ORDER BY p.name ASC
      LIMIT ${Math.min(limit, 500)}
    `.execute(this.dbs.db);
    return result.rows.map((r) => ({
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      branchId: r.branch_id,
      quantityRemaining: Number(r.quantity_remaining),
      valueMinor: Math.round(Number(r.value_minor)),
    }));
  }

  async movements(tenantId: string, productId?: string, limit = 200) {
    let query = this.dbs.db
      .selectFrom('inventory_movements')
      .leftJoin('products', 'products.id', 'inventory_movements.product_id')
      .select([
        'inventory_movements.id',
        'inventory_movements.product_id',
        'inventory_movements.branch_id',
        'products.sku',
        'inventory_movements.quantity_delta',
        'inventory_movements.reason',
        'inventory_movements.source_type',
        'inventory_movements.source_id',
        'inventory_movements.cogs_minor',
        'inventory_movements.occurred_at',
      ])
      .where('inventory_movements.tenant_id', '=', tenantId)
      .orderBy('inventory_movements.occurred_at', 'desc');
    if (productId) query = query.where('inventory_movements.product_id', '=', productId);
    return query.limit(Math.min(limit, 500)).execute();
  }
}
