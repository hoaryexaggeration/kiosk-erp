import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/database';
import { DbService } from '../../db/db.service';
import { EventsService } from '../platform/events.service';
import {
  DispatchTransfer,
  OpeningStockImportInput,
  ReceiveTransfer,
  StockAdjustmentPayload,
  StockReceiptPayload,
  StockTransferPayload,
} from './inventory.schema';
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
import { convertQuantity, UnitKind } from '../../domain/units';

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
  /**
   * Inbound only: the cost per BASE unit that opens a FIFO valuation layer (ADR 0009). Converting a
   * cost the supplier quoted for a pack into that per-unit figure is the caller's job — see
   * `receiveStock`, which divides by the same factor it multiplied the quantity by.
   */
  unitCostMinor?: number;
  /**
   * What an outbound movement does with the cost it draws out of the layers:
   *
   * - `expense` (the default) books it as `cogs_minor` — goods that left the business (a sale, a
   *   write-off, shrinkage).
   * - `transfer` draws the same layers but books NO cost of goods sold, because those goods did not
   *   leave the business: the cost travels with them (item 4.7) and is reopened as a layer at the
   *   destination. `consumedCostMinor` then reports what travelled, which is what the transfer
   *   document stores so the two branches stay valued at one amount.
   */
  costMode?: 'expense' | 'transfer';
}

export interface MovementResult {
  /** Resulting on-hand quantity (derived projection). */
  quantity: number;
  /** FIFO cost booked as cost of goods sold/lost by an outbound movement; 0 for inbound and for a transfer. */
  cogsMinor: number;
  /** FIFO cost actually drawn out of the layers — equals `cogsMinor` unless the movement carried it elsewhere. */
  consumedCostMinor: number;
  /** Outbound quantity with no layer to draw on — i.e. stock went negative. */
  uncostedQuantity: number;
  /** The quantity actually written to the ledger, in the base unit and signed like the delta (item 4.6). */
  baseQuantity: number;
}

/**
 * A quantity expressed in some unit, translated into the product's BASE unit — item 4.6, "buying in
 * crates and selling in pieces keeps one stock ledger".
 *
 * `baseQuantity` is the ONLY number the ledger may store. `factor` and `kind` come along so a
 * receipt can convert its cost by exactly the same factor it converted its quantity (a crate price
 * becomes a bottle price), and `converted` says whether any translation happened at all — when it
 * did, the pair the operator typed is remembered alongside the movement so history can show
 * "10 crate → +240 ea" instead of a number no GRN contains.
 */
export interface ResolvedQuantity {
  baseQuantity: number;
  baseUnit: string;
  /** How many base units one stated unit contains; 1 when nothing was converted. */
  factor: number;
  kind: UnitKind;
  converted: boolean;
}

/**
 * The outcome of resolving one line. `missing` keeps today's behaviour of skipping a product that no
 * longer exists rather than failing a whole document; `invalid` is a refusal the caller reports as a
 * rejected command WITH a stable code, so the operator learns which pack size was never defined
 * instead of receiving stock in the wrong unit.
 */
export type ResolveOutcome =
  | { status: 'ok'; resolved: ResolvedQuantity }
  | { status: 'missing' }
  | { status: 'invalid'; code: string; message: string };

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
  /**
   * What the file said when it named a unit other than the product's base one (item 4.6): null for
   * the overwhelming majority of rows, and the reason the numbers above it differ from the file.
   */
  enteredUnit: string | null;
  enteredQuantity: number | null;
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
   * Translate a quantity written in `unit` into the product's base unit — THE one place that
   * decides what reaches the ledger (item 4.6).
   *
   * One left-joined query returns the product's base unit, its kind (what a quantity in that unit
   * is allowed to be) and the factor of the unit the caller named. Everything else follows the
   * shared contract in `domain/units.ts`, so the refusal an operator sees for "1.3 crates" is the
   * same refusal the fixtures check in JavaScript, Kotlin and Swift.
   *
   * The identity path (no unit, or the unit IS the base) short-circuits before any conversion: the
   * quantity is recorded exactly as given, with no rounding and no new refusal — nothing about a
   * movement that was already correct changes today.
   */
  private async resolveQuantity(
    trx: Kysely<Database>,
    tenantId: string,
    productId: string,
    quantity: number,
    unit?: string | null,
  ): Promise<ResolveOutcome> {
    const requested = (unit ?? '').trim();
    // `requested` is empty for the identity case, which matches no conversion row — the CHECK on
    // the table forbids an empty unit code.
    const row = await sql<{ base_unit: string | null; kind: string | null; factor: string | null }>`
      SELECT p.unit AS base_unit,
             u.kind,
             uc.factor
        FROM products p
        LEFT JOIN units_of_measure u
          ON u.tenant_id = p.tenant_id AND lower(u.code) = lower(p.unit)
        LEFT JOIN unit_conversions uc
          ON uc.tenant_id = p.tenant_id AND uc.product_id = p.id AND lower(uc.unit) = lower(${requested})
       WHERE p.id = ${productId} AND p.tenant_id = ${tenantId}
    `.execute(trx);

    const baseUnit = row.rows[0]?.base_unit ?? null;
    if (baseUnit === null) return { status: 'missing' };

    const kind = (row.rows[0]?.kind ?? 'count') as UnitKind;
    if (requested.length === 0 || requested.toLowerCase() === baseUnit.toLowerCase()) {
      // The pack rule applies to the base unit too: `0.5 ea` is not a thing a shop can hold, however
      // the quantity was written. When the unit's kind is unknown we deliberately do NOT fall back
      // to `count` — with no rule there is no refusal (and no rounding either), because inventing a
      // rule for a weighed product nobody typed into the vocabulary would stop a legal receipt.
      if (row.rows[0]?.kind != null) {
        const identity = convertQuantity({ quantity, fromFactor: 1, toFactor: 1, kind });
        if (!identity.ok) {
          return {
            status: 'invalid',
            code: identity.code,
            message:
              identity.code === 'FRACTIONAL_QUANTITY'
                ? `${baseUnit} is counted, so a quantity in it must be a whole number — ${quantity} is not`
                : `Cannot accept ${quantity} ${baseUnit}`,
          };
        }
        return {
          status: 'ok',
          resolved: { baseQuantity: identity.quantity, baseUnit, factor: 1, kind, converted: false },
        };
      }
      return {
        status: 'ok',
        resolved: { baseQuantity: quantity, baseUnit, factor: 1, kind, converted: false },
      };
    }

    const factorRaw = row.rows[0]?.factor ?? null;
    if (row.rows[0]?.kind == null) {
      return {
        status: 'invalid',
        code: 'UNKNOWN_UNIT',
        message: `Selling unit "${baseUnit}" is not in this shop's unit catalogue — add it under Units first`,
      };
    }
    if (factorRaw === null) {
      return {
        status: 'invalid',
        code: 'UNKNOWN_CONVERSION',
        message: `No pack size for ${productId}: 1 ${requested} is not defined as ${baseUnit}. Add the conversion under the product first`,
      };
    }

    const outcome = convertQuantity({ quantity, fromFactor: Number(factorRaw), toFactor: 1, kind });
    if (!outcome.ok) {
      return {
        status: 'invalid',
        code: outcome.code,
        message:
          outcome.code === 'FRACTIONAL_QUANTITY'
            ? `${quantity} ${requested} is not a whole number of ${baseUnit}, which is counted rather than weighed`
            : `Cannot express ${quantity} ${requested} in ${baseUnit}`,
      };
    }
    return {
      status: 'ok',
      resolved: { baseQuantity: outcome.quantity, baseUnit, factor: Number(factorRaw), kind, converted: true },
    };
  }

  /**
   * The single write path for on-hand stock. Appends the movement fact, updates the derived
   * balance, and applies FIFO valuation (ADR 0009): a receipt opens a cost layer; an issue
   * consumes the oldest open layers and records exactly what it cost — except `costMode: 'transfer'`,
   * which consumes them so the cost can be reopened at the destination instead of being sold.
   *
   * This is also the choke point for item 4.6: whatever unit a caller's quantity is written in, the
   * row that lands records the BASE quantity and base unit, so no path — a receipt in crates, an
   * adjustment in packs, a future transfer in trays — can append to a second ledger. The pack it
   * arrived as is kept in `entered_unit`/`entered_quantity` when a conversion actually happened.
   *
   * A movement is never withheld to preserve a fact — if an issue outruns the available layers the
   * movement still stands and `uncostedQuantity` reports the shortfall so the caller can raise a
   * visible exception (the till blocks it up front; the server preserves the evidence).
   */
  async applyMovement(trx: Kysely<Database>, m: ApplyMovement): Promise<MovementResult> {
    const movementId = crypto.randomUUID();
    const outcome = await this.resolveQuantity(trx, m.tenantId, m.productId, m.quantityDelta, m.unit);
    if (outcome.status === 'invalid') throw new AppError(outcome.code, outcome.message, 400);
    // A product that has vanished still deserves its fact recorded, exactly as it always has.
    const resolved: ResolvedQuantity | null = outcome.status === 'ok' ? outcome.resolved : null;
    const baseQuantity = resolved ? resolved.baseQuantity : m.quantityDelta;
    const baseUnit = resolved ? resolved.baseUnit : m.unit ?? 'ea';
    const converted = resolved?.converted ?? false;

    await trx
      .insertInto('inventory_movements')
      .values({
        id: movementId,
        tenant_id: m.tenantId,
        branch_id: m.branchId,
        location_id: m.locationId,
        product_id: m.productId,
        quantity_delta: baseQuantity,
        unit: baseUnit,
        // Only a real conversion leaves a trace; a movement already in the base unit adds no noise.
        entered_unit: converted ? (m.unit ?? null) : null,
        entered_quantity: converted ? m.quantityDelta : null,
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
      VALUES (${m.tenantId}, ${m.branchId}, ${m.locationId}, ${m.productId}, ${baseQuantity}, now())
      ON CONFLICT (tenant_id, branch_id, location_id, product_id)
      DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
      RETURNING quantity
    `.execute(trx);
    const quantity = Number(row.rows[0]?.quantity ?? 0);

    let cogsMinor = 0;
    let consumedCostMinor = 0;
    let uncostedQuantity = 0;

    if (baseQuantity > 0) {
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
          quantity_received: baseQuantity,
          quantity_remaining: baseQuantity,
        })
        .execute();
    } else if (baseQuantity < 0) {
      let needed = -baseQuantity;
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
        consumedCostMinor += amount;
        needed -= take;
      }
      uncostedQuantity = needed > 0 ? needed : 0;
      // A transfer draws the same cost out of the source's layers but does not sell or lose it, so
      // the movement records no cost of goods sold — the figure belongs to whichever branch ends up
      // holding the goods (item 4.7). Everything else books it here, in the transaction that
      // recorded the fact; the quantity/reason/actor fields of a movement are never rewritten.
      cogsMinor = (m.costMode ?? 'expense') === 'transfer' ? 0 : consumedCostMinor;
      if (cogsMinor !== 0) {
        await trx.updateTable('inventory_movements').set({ cogs_minor: cogsMinor }).where('id', '=', movementId).execute();
      }
    }

    return { quantity, cogsMinor, consumedCostMinor, uncostedQuantity, baseQuantity };
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

  /**
   * Stock receipt (GRN): increase on-hand and open a FIFO valuation layer per line (ADR 0009).
   *
   * Item 4.6: every line is resolved into the product's base unit BEFORE a single movement is
   * written, so a receipt that names a pack size the product cannot convert is refused whole
   * instead of half-applying. The cost a supplier quoted is per the unit they charged for — a crate
   * price becomes a per-bottle price through the same factor as the quantity, which is what keeps
   * the layer's value equal to the invoice the shop actually paid.
   */
  async receiveStock(trx: Kysely<Database>, ctx: InventoryContext, payload: StockReceiptPayload): Promise<ApplyResult> {
    const receipt = payload.receipt;
    const locationId = receipt.locationId ?? (await this.getOrCreateLocation(trx, ctx.tenantId, ctx.branchId));
    let totalValueMinor = 0;
    let convertedLines = 0;

    interface PreparedLine {
      line: StockReceiptPayload['receipt']['lines'][number];
      product: { cost_minor: number; unit: string };
      resolved: ResolvedQuantity;
    }
    const prepared: PreparedLine[] = [];

    for (const line of receipt.lines) {
      const product = await trx
        .selectFrom('products')
        .select(['id', 'sku', 'cost_minor', 'unit', 'deleted_at'])
        .where('id', '=', line.productId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!product || product.deleted_at) continue;

      const outcome = await this.resolveQuantity(trx, ctx.tenantId, line.productId, line.quantity, line.unit);
      if (outcome.status === 'missing') continue;
      if (outcome.status === 'invalid') {
        return { status: 'rejected' as const, code: outcome.code, message: outcome.message };
      }
      if (outcome.resolved.converted) convertedLines += 1;
      prepared.push({ line, product, resolved: outcome.resolved });
    }

    for (const { line, product, resolved } of prepared) {
      // A cost is quoted per the unit on the paperwork. `products.cost_minor` is the opposite: the
      // latest known cost PER BASE UNIT (it is what an uncosted fallback layer would use), so it is
      // never divided — only a cost the supplier actually stated travels down the factor.
      const unitCostMinor =
        line.unitCostMinor !== undefined
          ? resolved.converted
            ? roundHalfUp(line.unitCostMinor / resolved.factor)
            : line.unitCostMinor
          : Number(product.cost_minor);

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
        await trx.updateTable('products').set({ cost_minor: unitCostMinor, updated_at: new Date() }).where('id', '=', line.productId).execute();
      }
      // Value of the lines as the layers will hold them: base quantity × per-base-unit cost, so the
      // audit total can never disagree with the valuation the same transaction just opened.
      totalValueMinor += roundHalfUp(resolved.baseQuantity * unitCostMinor);
    }

    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'stock.received',
      aggregateType: 'StockReceipt',
      aggregateId: receipt.id,
      after: { lineCount: receipt.lines.length, totalValueMinor, convertedLines },
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
    let convertedLines = 0;

    interface PreparedLine {
      line: StockAdjustmentPayload['adjustment']['lines'][number];
      resolved: ResolvedQuantity;
    }
    const prepared: PreparedLine[] = [];

    // Resolve EVERY line first — the pack size as well as the reason — because a partially applied
    // adjustment must never commit: "−2 crates" is either recorded as −48 bottles or not at all.
    for (const line of adjustment.lines) {
      const outcome = await this.resolveQuantity(trx, ctx.tenantId, line.productId, line.quantityDelta, line.unit);
      if (outcome.status === 'missing') continue;
      if (outcome.status === 'invalid') {
        return { status: 'rejected' as const, code: outcome.code, message: outcome.message };
      }
      if (outcome.resolved.converted) convertedLines += 1;
      prepared.push({ line, resolved: outcome.resolved });
    }

    // A negative adjustment needs an explicit supervisor override note. The comparison is against
    // the BASE quantity, because that is what the balance holds — comparing 2 crates against 24
    // bottles would approve a write the projection then refuses.
    if (!adjustment.approvalNote) {
      for (const { line, resolved } of prepared) {
        if (resolved.baseQuantity >= 0) continue;
        const available = await this.onHand(trx, ctx.tenantId, ctx.branchId, locationId, line.productId);
        if (available + resolved.baseQuantity < 0) {
          return {
            status: 'rejected' as const,
            code: 'OVERRIDE_REQUIRED',
            message: `Adjustment would take ${line.productId} below zero; a supervisor override note is required`,
            conflictCodes: ['NEGATIVE_STOCK'],
          };
        }
      }
    }

    for (const { line, resolved } of prepared) {
      const movement = await this.applyMovement(trx, {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId,
        productId: line.productId,
        quantityDelta: line.quantityDelta,
        unit: line.unit ?? resolved.baseUnit,
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
      after: { lineCount: adjustment.lines.length, convertedLines },
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

  // --- cross-branch transfers (item 4.7, ADR 0008) ----------------------------------------------

  /**
   * One document, two per-branch steps: the source dispatches, the destination receives, and no
   * command ever writes the other branch's ledger (ADR 0008 item 5 — the branch a command applies
   * to is `command.branchId`, which sync checks against the device's enrolment).
   *
   * Between those two steps the goods are held by NEITHER branch: dispatch removes them from the
   * source and the destination counts them in later, so at no instant is the same stock counted in
   * two branches — the exit criterion for this item.
   */
  async applyTransfer(trx: Kysely<Database>, ctx: InventoryContext, payload: StockTransferPayload): Promise<ApplyResult> {
    return payload.action === 'dispatch'
      ? this.dispatchTransfer(trx, ctx, payload.transfer)
      : this.receiveTransfer(trx, ctx, payload.transfer);
  }

  /** Step 1 — stock leaves the source branch and the document enters `dispatched`. */
  private async dispatchTransfer(trx: Kysely<Database>, ctx: InventoryContext, transfer: DispatchTransfer): Promise<ApplyResult> {
    const destination = await trx
      .selectFrom('branches')
      .select(['id', 'name'])
      .where('id', '=', transfer.toBranchId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!destination) {
      return { status: 'rejected', code: 'UNKNOWN_BRANCH', message: `Branch ${transfer.toBranchId} does not belong to this shop` };
    }
    if (transfer.toBranchId === ctx.branchId) {
      return { status: 'rejected', code: 'SAME_BRANCH', message: 'A transfer needs a destination other than this branch — send it somewhere else, or post it as an adjustment here' };
    }

    const locationId = await this.getOrCreateLocation(trx, ctx.tenantId, ctx.branchId);

    interface PreparedDispatch {
      line: DispatchTransfer['lines'][number];
      product: { sku: string; costMinor: number };
      resolved: ResolvedQuantity;
    }
    const prepared: PreparedDispatch[] = [];

    // Resolve EVERY line before writing anything: a transfer is dispatched whole or not at all,
    // because a partly dispatched document would tell the destination a story the source's ledger
    // cannot back up. A product this branch does not know is dropped, as on a receipt; if that
    // empties the document there is nothing to send and no document is created.
    for (const line of transfer.lines) {
      const product = await trx
        .selectFrom('products')
        .select(['sku', 'cost_minor', 'deleted_at'])
        .where('id', '=', line.productId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!product || product.deleted_at) continue;
      const outcome = await this.resolveQuantity(trx, ctx.tenantId, line.productId, line.quantity, line.unit);
      if (outcome.status === 'missing') continue;
      if (outcome.status === 'invalid') return { status: 'rejected', code: outcome.code, message: outcome.message };
      prepared.push({ line, product: { sku: product.sku, costMinor: Number(product.cost_minor) }, resolved: outcome.resolved });
    }
    if (prepared.length === 0) {
      return { status: 'rejected', code: 'EMPTY_TRANSFER', message: 'None of the products on this transfer exists at this branch' };
    }

    // Sending what this branch does not have would push the source below zero. A supervisor note
    // overrides it exactly as for a negative adjustment (ADR 0009) — one rule, one outcome — and a
    // dispatch without one is refused rather than queued for a surprise at the next sync.
    if (!transfer.approvalNote) {
      for (const { line, product, resolved } of prepared) {
        const available = await this.onHand(trx, ctx.tenantId, ctx.branchId, locationId, line.productId);
        if (available >= resolved.baseQuantity) continue;
        return {
          status: 'rejected',
          code: 'INSUFFICIENT_STOCK',
          message: `${product.sku}: ${resolved.baseQuantity} ${resolved.baseUnit} asked for but only ${available} on hand at this branch — receive the stock first, or have a supervisor approve sending it`,
          conflictCodes: ['NEGATIVE_STOCK'],
        };
      }
    }

    const reference = await this.nextTransferReference(trx, ctx.tenantId);
    await trx
      .insertInto('stock_transfers')
      .values({
        id: transfer.id,
        tenant_id: ctx.tenantId,
        reference,
        from_branch_id: ctx.branchId,
        to_branch_id: transfer.toBranchId,
        status: 'dispatched',
        note: transfer.note ?? null,
        dispatched_by: ctx.actorId,
        dispatched_at: new Date(),
        received_by: null,
        received_at: null,
        approved_by: transfer.approvedBy ?? null,
        approval_note: transfer.approvalNote ?? null,
        line_count: prepared.length,
      })
      .execute();

    let negative = false;
    let uncosted = false;
    let dispatchedValueMinor = 0;

    for (const { line, product, resolved } of prepared) {
      const movement = await this.applyMovement(trx, {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId,
        productId: line.productId,
        // The ENTERED quantity and unit, exactly as on a receipt or an adjustment: `applyMovement`
        // is the one place that converts a pack into base units, and it records what was written.
        quantityDelta: -line.quantity,
        unit: line.unit ?? resolved.baseUnit,
        reason: 'transfer_out',
        sourceType: 'stock_transfer',
        sourceId: transfer.id,
        actorId: ctx.actorId,
        deviceId: ctx.deviceId,
        commandId: ctx.commandId,
        approvedBy: transfer.approvedBy ?? null,
        approvalNote: transfer.approvalNote ?? null,
        // The goods leave this branch, not the business: their cost is drawn out of the source's
        // layers and carried on the line below, ready to be reopened as a layer at the destination.
        costMode: 'transfer',
      });
      if (movement.quantity < 0) negative = true;
      if (movement.uncostedQuantity > 0) uncosted = true;

      // A movement's `baseQuantity` is SIGNED — a dispatch writes a negative delta — while a
      // document line is simply a quantity of goods that went out, so the sign goes and the size
      // stays. That number is what the destination will later count against.
      const dispatchedQuantity = Math.abs(movement.baseQuantity);

      // What travelled, per base unit: the source's FIFO cost spread over the units sent, so the
      // value is preserved exactly whatever the layers were made of. Stock with no layers to draw
      // on falls back to the product's latest known cost, the rule a receipt already follows — a
      // branch must never hand goods over valued at nothing.
      const unitCostMinor = movement.consumedCostMinor > 0 ? roundHalfUp(movement.consumedCostMinor / dispatchedQuantity) : product.costMinor;

      await trx
        .insertInto('stock_transfer_lines')
        .values({
          id: crypto.randomUUID(),
          tenant_id: ctx.tenantId,
          transfer_id: transfer.id,
          product_id: line.productId,
          unit: resolved.baseUnit,
          entered_unit: resolved.converted ? (line.unit ?? null) : null,
          entered_quantity: resolved.converted ? line.quantity : null,
          quantity_dispatched: dispatchedQuantity,
          quantity_received: null,
          unit_cost_minor: unitCostMinor,
        })
        .execute();
      dispatchedValueMinor += roundHalfUp(dispatchedQuantity * unitCostMinor);
    }

    const seq = await this.events.serverEvent(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      eventType: 'stock.transfer.dispatched',
      aggregateType: 'StockTransfer',
      aggregateId: transfer.id,
      payload: { reference, fromBranchId: ctx.branchId, toBranchId: transfer.toBranchId, status: 'dispatched', lineCount: prepared.length },
    });
    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'stock.transfer.dispatched',
      aggregateType: 'StockTransfer',
      aggregateId: transfer.id,
      reason: transfer.approvalNote ?? null,
      after: { reference, toBranchId: transfer.toBranchId, lineCount: prepared.length, dispatchedValueMinor, negative, uncosted },
      correlationId: ctx.correlationId,
    });
    await this.events.outbox(trx, ctx.tenantId, 'stock.transfer.dispatched', { transferId: transfer.id, reference, toBranchId: transfer.toBranchId });

    // Dispatching into negative stock (or from stock nobody has costed) is an exception, not a
    // silent success: the device shows it under "needs attention", same as a negative adjustment.
    const reviewRequired = negative || uncosted;
    return {
      status: reviewRequired ? ('review_required' as const) : ('accepted' as const),
      result: { transferId: transfer.id, reference, serverSeq: seq, negative, uncosted, lineCount: prepared.length },
      conflictCodes: reviewRequired ? ['NEGATIVE_STOCK'] : [],
    };
  }

  /** Step 2 — the destination counts what arrived, and the document closes as received or short. */
  private async receiveTransfer(trx: Kysely<Database>, ctx: InventoryContext, transfer: ReceiveTransfer): Promise<ApplyResult> {
    const document = await trx
      .selectFrom('stock_transfers')
      .select(['reference', 'from_branch_id', 'to_branch_id', 'status'])
      .where('id', '=', transfer.id)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!document) {
      return { status: 'rejected', code: 'UNKNOWN_TRANSFER', message: `No transfer ${transfer.id} on this server` };
    }
    if (document.to_branch_id !== ctx.branchId) {
      return {
        status: 'rejected',
        code: 'NOT_TRANSFER_DESTINATION',
        message: `Transfer ${document.reference} is addressed to another branch — the branch that sent it cannot receive it`,
      };
    }
    if (document.status !== 'dispatched') {
      return {
        status: 'rejected',
        code: 'ALREADY_RECEIVED',
        message: `Transfer ${document.reference} was already received (${document.status}) — goods that turn up later arrive on a receipt or a new transfer`,
      };
    }

    const lines = await trx
      .selectFrom('stock_transfer_lines')
      .innerJoin('products', 'products.id', 'stock_transfer_lines.product_id')
      .select([
        'stock_transfer_lines.id',
        'stock_transfer_lines.product_id',
        'stock_transfer_lines.unit',
        'stock_transfer_lines.quantity_dispatched',
        'stock_transfer_lines.unit_cost_minor',
        'products.sku',
      ])
      .where('stock_transfer_lines.transfer_id', '=', transfer.id)
      .where('stock_transfer_lines.tenant_id', '=', ctx.tenantId)
      .execute();

    const counted = new Map(transfer.lines.map((l) => [l.productId, l.quantityReceived]));
    // A receipt must account for every dispatched line and no others. A line the document does not
    // carry is an invented count; a line the receipt omits is an unexplained one — neither is a
    // discrepancy the server can approve on someone's behalf.
    const invented = transfer.lines.find((l) => !lines.some((row) => row.product_id === l.productId));
    if (invented) {
      return { status: 'rejected', code: 'UNKNOWN_RECEIPT_LINE', message: `Transfer ${document.reference} does not carry product ${invented.productId}` };
    }
    const omitted = lines.find((row) => !counted.has(row.product_id));
    if (omitted) {
      return { status: 'rejected', code: 'MISSING_RECEIPT_LINE', message: `Count ${omitted.sku} as well — transfer ${document.reference} sent it and the receipt does not say what arrived` };
    }

    let shortage = false;
    for (const row of lines) {
      const received = counted.get(row.product_id) ?? 0;
      const dispatched = Number(row.quantity_dispatched);
      if (received > dispatched) {
        return {
          status: 'rejected',
          code: 'RECEIVED_MORE_THAN_SENT',
          message: `${row.sku}: ${received} ${row.unit} received but only ${dispatched} was sent — stock that arrives unexpectedly belongs on a supplier receipt, not a transfer`,
        };
      }
      if (received < dispatched) shortage = true;
    }
    // Every shortage needs a supervisor note (owner decision, item 4.7): the note is what turns a
    // count into a decision, and it is refused BEFORE anything is written so nothing half-applies.
    if (shortage && !transfer.approvalNote) {
      return {
        status: 'rejected',
        code: 'OVERRIDE_REQUIRED',
        message: `Transfer ${document.reference} is short of what was sent; a supervisor override note is required`,
        conflictCodes: ['TRANSFER_SHORTAGE'],
      };
    }

    const locationId = await this.getOrCreateLocation(trx, ctx.tenantId, ctx.branchId);
    let receivedValueMinor = 0;
    let shortageQuantity = 0;
    let shortageValueMinor = 0;

    for (const row of lines) {
      const received = counted.get(row.product_id) ?? 0;
      const dispatched = Number(row.quantity_dispatched);
      const unitCostMinor = Number(row.unit_cost_minor);

      if (received > 0) {
        // The cost travelled with the goods (stamped at dispatch), so the destination opens its
        // layer at the very amount the source's layers gave up — the two sides can never disagree.
        await this.applyMovement(trx, {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          locationId,
          productId: row.product_id,
          quantityDelta: received,
          unit: row.unit,
          reason: 'transfer_in',
          sourceType: 'stock_transfer',
          sourceId: transfer.id,
          actorId: ctx.actorId,
          deviceId: ctx.deviceId,
          commandId: ctx.commandId,
          approvedBy: transfer.approvedBy ?? null,
          approvalNote: transfer.approvalNote ?? null,
          unitCostMinor,
        });
        receivedValueMinor += roundHalfUp(received * unitCostMinor);
      }

      // The shortfall is recorded on the document, NOT as a second movement: those units are
      // already out of the source, so writing them off again would delete stock twice. Their value
      // leaves with them — which is why a shortage is worth approving rather than ignoring.
      const short = dispatched - received;
      if (short > 0) {
        shortageQuantity += short;
        shortageValueMinor += roundHalfUp(short * unitCostMinor);
      }

      await trx
        .updateTable('stock_transfer_lines')
        .set({ quantity_received: received })
        .where('id', '=', row.id)
        .execute();
    }

    const status = shortage ? ('discrepancy' as const) : ('received' as const);
    await trx
      .updateTable('stock_transfers')
      .set({
        status,
        received_by: ctx.actorId,
        received_at: new Date(),
        approved_by: transfer.approvedBy ?? null,
        approval_note: transfer.approvalNote ?? null,
      })
      .where('id', '=', transfer.id)
      .execute();

    const seq = await this.events.serverEvent(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      eventType: 'stock.transfer.received',
      aggregateType: 'StockTransfer',
      aggregateId: transfer.id,
      payload: { reference: document.reference, fromBranchId: document.from_branch_id, toBranchId: document.to_branch_id, status, shortage: shortageQuantity },
    });
    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'stock.transfer.received',
      aggregateType: 'StockTransfer',
      aggregateId: transfer.id,
      reason: transfer.approvalNote ?? null,
      after: { reference: document.reference, status, receivedValueMinor, shortageQuantity, shortageValueMinor },
      correlationId: ctx.correlationId,
    });
    await this.events.outbox(trx, ctx.tenantId, 'stock.transfer.received', { transferId: transfer.id, reference: document.reference, status });

    return {
      status: shortage ? ('review_required' as const) : ('accepted' as const),
      result: {
        transferId: transfer.id,
        reference: document.reference,
        status,
        serverSeq: seq,
        shortageQuantity,
        shortageValueMinor,
        receivedValueMinor,
      },
      conflictCodes: shortage ? ['TRANSFER_SHORTAGE'] : [],
    };
  }

  /**
   * `TRF-0001` — a tenant-wide series, so two branches quoting a reference over the phone can only
   * be talking about one transfer. The row is created if missing (the partial unique index from
   * migration 0006 keeps one per tenant) and the UPDATE takes the row lock, so two branches
   * dispatching at the same instant cannot be handed the same number.
   */
  private async nextTransferReference(trx: Kysely<Database>, tenantId: string): Promise<string> {
    await trx
      .insertInto('numbering_series')
      .values({ tenant_id: tenantId, branch_id: null, name: 'transfers', prefix: 'TRF-', next_value: 1 })
      .onConflict((oc) => oc.doNothing())
      .execute();
    const row = await trx
      .updateTable('numbering_series')
      .set({ next_value: sql<number>`next_value + 1` })
      .where('tenant_id', '=', tenantId)
      .where('name', '=', 'transfers')
      .where('branch_id', 'is', null)
      .returning('next_value')
      .executeTakeFirstOrThrow();
    return `TRF-${String(Number(row.next_value) - 1).padStart(4, '0')}`;
  }

  /** The branch a device is enrolled against, or null when it cannot be established (§9 scoping). */
  async deviceBranch(tenantId: string, deviceId: string): Promise<string | null> {
    const device = await this.dbs.db
      .selectFrom('devices')
      .select('branch_id')
      .where('id', '=', deviceId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return device?.branch_id ?? null;
  }

  /**
   * Transfers this branch is party to, newest first, with the branch names both sides need to say
   * where the goods are. Scoped to the one branch asked for (ADR 0008 item 5: a till reads its own
   * branch's stock; the consolidated cross-branch view belongs to a reporting role in Phase 9).
   */
  async transfers(tenantId: string, branchId: string, deviceId: string | undefined, limit = 200) {
    // A device may only ask about its own branch — otherwise any till could read the movement
    // between two branches it does not run. A session with no device (an operator at a desk) is
    // free to ask about any branch of its own tenant.
    if (deviceId) {
      const enrolled = await this.deviceBranch(tenantId, deviceId);
      if (enrolled && enrolled !== branchId) {
        throw new AppError('BRANCH_MISMATCH', 'This device is enrolled against another branch', 403);
      }
    }

    const rows = await this.dbs.db
      .selectFrom('stock_transfers')
      .where('tenant_id', '=', tenantId)
      .where(({ eb, or }) => or([eb('from_branch_id', '=', branchId), eb('to_branch_id', '=', branchId)]))
      .orderBy('dispatched_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 500))
      .selectAll()
      .execute();
    if (rows.length === 0) return [];

    const branchIds = [...new Set(rows.flatMap((r) => [r.from_branch_id, r.to_branch_id]))];
    const branches = await this.dbs.db
      .selectFrom('branches')
      .select(['id', 'name'])
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', branchIds)
      .execute();
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    const lineRows = await this.dbs.db
      .selectFrom('stock_transfer_lines')
      .innerJoin('products', 'products.id', 'stock_transfer_lines.product_id')
      .select([
        'stock_transfer_lines.transfer_id',
        'stock_transfer_lines.product_id',
        'stock_transfer_lines.unit',
        'stock_transfer_lines.entered_unit',
        'stock_transfer_lines.entered_quantity',
        'stock_transfer_lines.quantity_dispatched',
        'stock_transfer_lines.quantity_received',
        'stock_transfer_lines.unit_cost_minor',
        'products.sku',
        'products.name',
      ])
      .where(
        'stock_transfer_lines.transfer_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('stock_transfer_lines.tenant_id', '=', tenantId)
      .execute();
    const byTransfer = new Map<string, typeof lineRows>();
    for (const line of lineRows) {
      const list = byTransfer.get(line.transfer_id) ?? [];
      list.push(line);
      byTransfer.set(line.transfer_id, list);
    }

    return rows.map((row) => {
      const lines = (byTransfer.get(row.id) ?? []).map((line) => {
        const dispatched = Number(line.quantity_dispatched);
        const received = line.quantity_received === null ? null : Number(line.quantity_received);
        return {
          productId: line.product_id,
          sku: line.sku,
          name: line.name,
          unit: line.unit,
          enteredUnit: line.entered_unit,
          enteredQuantity: line.entered_quantity === null ? null : Number(line.entered_quantity),
          dispatched,
          received,
          unitCostMinor: Number(line.unit_cost_minor),
          // What is still missing on this line — 0 while the transfer is open (nobody has counted
          // yet, so nothing is missing), the shortfall once it has been received short.
          shortage: received === null ? 0 : Math.max(dispatched - received, 0),
        };
      });
      return {
        id: row.id,
        reference: row.reference,
        fromBranchId: row.from_branch_id,
        toBranchId: row.to_branch_id,
        fromBranchName: branchName.get(row.from_branch_id) ?? row.from_branch_id,
        toBranchName: branchName.get(row.to_branch_id) ?? row.to_branch_id,
        status: row.status,
        note: row.note,
        approvalNote: row.approval_note,
        dispatchedAt: row.dispatched_at,
        receivedAt: row.received_at,
        lineCount: row.line_count,
        // How many units are physically out on this document right now. Open = in transit; a
        // received document has arrived (whatever is short stayed behind as a documented loss).
        inTransitQuantity: row.status === 'dispatched' ? lines.reduce((s, l) => s + l.dispatched, 0) : 0,
        shortageQuantity: lines.reduce((s, l) => s + l.shortage, 0),
        lines,
      };
    });
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
        // What the file said, when it said something else — the pair the operator checks against
        // their own paperwork before approving the conversion (item 4.6).
        enteredUnit: row.enteredUnit,
        enteredQuantity: row.enteredQuantity,
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
          // A row written in a pack is committed AS that pack: `applyMovement` converts it to the
          // base unit (once, by the same rule the planner previewed) and keeps the pair on the
          // movement, so history reads like the file the operator approved.
          quantityDelta: row.enteredQuantity ?? row.quantity,
          unit: row.enteredUnit ?? row.unit,
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
          // How many rows arrived in a pack rather than the unit stock is held in (item 4.6).
          convertedLines: plan.rows.filter((row) => row.enteredUnit !== null).length,
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
    const [products, balances, openings, trading, units, conversions] = await Promise.all([
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
      // What a unit means, and which packs each product is written in — item 4.6. Both are read
      // here so the planner stays a pure function that decides conversion, refusal and rounding
      // before anything is written.
      db.selectFrom('units_of_measure').select(['code', 'kind']).where('tenant_id', '=', tenantId).execute(),
      db.selectFrom('unit_conversions').select(['product_id', 'unit', 'factor']).where('tenant_id', '=', tenantId).execute(),
    ]);

    const kindByCode = new Map(units.map((row) => [row.code.toLowerCase(), row.kind as UnitKind]));
    const conversionsByProduct = new Map<string, Map<string, number>>();
    for (const row of conversions) {
      const byProduct = conversionsByProduct.get(row.product_id) ?? new Map<string, number>();
      byProduct.set(row.unit.toLowerCase(), Number(row.factor));
      conversionsByProduct.set(row.product_id, byProduct);
    }

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
        // Kind of the base unit, or null when the catalogue has never typed it. A product may only
        // carry conversions for a base unit the catalogue knows (the catalogue refuses to write
        // otherwise), so `count` is NOT assumed here: with no kind there is no rule, and inventing
        // one would let a preview accept what its own commit then refuses.
        unitKind: kindByCode.get(row.unit.toLowerCase()) ?? null,
        conversions: conversionsByProduct.get(row.id) ?? new Map<string, number>(),
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
        // The base unit every movement is held in (item 4.6) — history shows one unit per product.
        'inventory_movements.unit',
        // What the paperwork said when it was a different unit, e.g. 10 crate for +240 ea.
        'inventory_movements.entered_unit',
        'inventory_movements.entered_quantity',
        'inventory_movements.reason',
        'inventory_movements.source_type',
        'inventory_movements.source_id',
        'inventory_movements.cogs_minor',
        'inventory_movements.occurred_at',
      ])
      .where('inventory_movements.tenant_id', '=', tenantId)
      .orderBy('inventory_movements.occurred_at', 'desc');
    if (productId) query = query.where('inventory_movements.product_id', '=', productId);
    const rows = await query.limit(Math.min(limit, 500)).execute();
    // `entered_quantity` is `numeric(18,3)`, which Postgres returns as a string — coerced once, here.
    return rows.map((row) => ({ ...row, entered_quantity: row.entered_quantity === null ? null : Number(row.entered_quantity) }));
  }
}
