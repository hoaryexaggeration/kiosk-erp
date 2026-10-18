import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/database';
import { DbService } from '../../db/db.service';
import { EventsService } from '../platform/events.service';
import { StockAdjustmentPayload, StockReceiptPayload } from './inventory.schema';
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
}

const DEFAULT_LOCATION_NAME = 'Store';

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

  /** Append a movement and update the derived balance. Returns the resulting on-hand quantity. */
  async applyMovement(trx: Kysely<Database>, m: ApplyMovement): Promise<number> {
    await trx
      .insertInto('inventory_movements')
      .values({
        id: crypto.randomUUID(),
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
      })
      .execute();

    const row = await sql<{ quantity: number }>`
      INSERT INTO stock_balances (tenant_id, branch_id, location_id, product_id, quantity, updated_at)
      VALUES (${m.tenantId}, ${m.branchId}, ${m.locationId}, ${m.productId}, ${m.quantityDelta}, now())
      ON CONFLICT (tenant_id, branch_id, location_id, product_id)
      DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
      RETURNING quantity
    `.execute(trx);
    return Number(row.rows[0]?.quantity ?? 0);
  }

  /** Stock receipt (GRN): increase on-hand and roll the weighted-average cost forward. */
  async receiveStock(trx: Kysely<Database>, ctx: InventoryContext, payload: StockReceiptPayload) {
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
      });

      if (line.unitCostMinor !== undefined) {
        // Weighted average across the branch's on-hand for this product (ADR 0006).
        const totals = await trx
          .selectFrom('stock_balances')
          .select(({ fn }) => fn.sum<number>('quantity').as('qty'))
          .where('tenant_id', '=', ctx.tenantId)
          .where('branch_id', '=', ctx.branchId)
          .where('product_id', '=', line.productId)
          .executeTakeFirst();
        const qtyAfter = Number(totals?.qty ?? line.quantity);
        const qtyBefore = qtyAfter - line.quantity;
        const oldCost = Number(product.cost_minor);
        const newCost =
          qtyAfter > 0
            ? roundHalfUp((qtyBefore * oldCost + line.quantity * line.unitCostMinor) / qtyAfter)
            : line.unitCostMinor;
        await trx.updateTable('products').set({ cost_minor: newCost, updated_at: new Date() }).where('id', '=', line.productId).execute();
        totalValueMinor += line.quantity * line.unitCostMinor;
      }
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

  /** Stock adjustment: audited, reason-required, and never silently negative. */
  async adjustStock(trx: Kysely<Database>, ctx: InventoryContext, payload: StockAdjustmentPayload) {
    const adjustment = payload.adjustment;
    const locationId = adjustment.locationId ?? (await this.getOrCreateLocation(trx, ctx.tenantId, ctx.branchId));
    let negative = false;

    for (const line of adjustment.lines) {
      const product = await trx
        .selectFrom('products')
        .select(['id', 'unit'])
        .where('id', '=', line.productId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!product) continue;
      const resulting = await this.applyMovement(trx, {
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
        approvalNote: adjustment.approvalNote ?? null,
      });
      if (resulting < 0) negative = true;
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
      payload: { reason: adjustment.reason, negative },
    });
    await this.events.outbox(trx, ctx.tenantId, 'stock.adjusted', { adjustmentId: adjustment.id });

    return {
      status: negative ? ('review_required' as const) : ('accepted' as const),
      result: { adjustmentId: adjustment.id, serverSeq: seq, negative },
      conflictCodes: negative ? ['NEGATIVE_STOCK'] : [],
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

  async movements(tenantId: string, productId?: string, limit = 200) {
    let query = this.dbs.db
      .selectFrom('inventory_movements')
      .leftJoin('products', 'products.id', 'inventory_movements.product_id')
      .select([
        'inventory_movements.id',
        'inventory_movements.product_id',
        'products.sku',
        'inventory_movements.quantity_delta',
        'inventory_movements.reason',
        'inventory_movements.source_type',
        'inventory_movements.source_id',
        'inventory_movements.occurred_at',
      ])
      .where('inventory_movements.tenant_id', '=', tenantId)
      .orderBy('inventory_movements.occurred_at', 'desc');
    if (productId) query = query.where('inventory_movements.product_id', '=', productId);
    return query.limit(Math.min(limit, 500)).execute();
  }
}
