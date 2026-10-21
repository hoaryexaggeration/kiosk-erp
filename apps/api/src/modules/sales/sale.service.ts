import { Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/database';
import { computeLine, computeDocument } from '../../domain/pricing';
import { EventsService } from '../platform/events.service';
import { InventoryService } from '../inventory/inventory.service';
import { PricingService } from '../pricing/pricing.service';
import { SalePayload } from '../sync/command.schema';

export interface SaleApplyContext {
  tenantId: string;
  branchId: string;
  deviceId: string;
  actorId: string;
  commandId: string;
  correlationId: string;
}

export interface SaleApplyResult {
  status: 'accepted' | 'review_required';
  result: Record<string, unknown>;
  conflictCodes: string[];
}

@Injectable()
export class SaleService {
  private readonly logger = new Logger(SaleService.name);

  constructor(
    private readonly events: EventsService,
    private readonly inventory: InventoryService,
    private readonly pricing: PricingService,
  ) {}

  /**
   * Apply a Sale command inside a single transaction (§5 write path, §1.6 rule 2).
   * Preserves sale-time price/tax snapshots, writes append-only stock movements, posts a
   * canonical journal, and raises visible exceptions for credit/stock policy breaches.
   */
  async applySale(trx: Kysely<Database>, ctx: SaleApplyContext, payload: SalePayload): Promise<SaleApplyResult> {
    const { sale } = payload;
    const conflictCodes: string[] = [];
    const warnings: string[] = [];

    // Idempotency at the aggregate level too.
    const existing = await trx.selectFrom('sales').select('id').where('id', '=', sale.id).executeTakeFirst();
    if (existing) {
      return { status: 'accepted', result: { saleId: sale.id, note: 'already applied' }, conflictCodes };
    }

    const branch = await trx
      .selectFrom('branches')
      .select('id')
      .where('id', '=', ctx.branchId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!branch) {
      return { status: 'review_required', result: { code: 'DELETED_REFERENCE', message: 'Branch not found' }, conflictCodes: ['DELETED_REFERENCE'] };
    }

    // --- resolve product snapshots & compute authoritative line figures -------------
    const lineRows: Array<{
      id: string; productId: string | null; sku: string; name: string; unit: string;
      quantity: number; unitPriceMinor: number; discountBp: number; taxRateBp: number; taxInclusive: boolean;
      discountMinor: number; netMinor: number; taxMinor: number; lineTotalMinor: number; costMinor: number; stockTracked: boolean;
    }> = [];

    for (const line of sale.lines) {
      let product: { id: string; sku: string; name: string; unit: string; cost_minor: number; is_stock_tracked: boolean; tax_category_id: string | null } | undefined;
      if (line.productId) {
        product = await trx
          .selectFrom('products')
          .select(['id', 'sku', 'name', 'unit', 'cost_minor', 'is_stock_tracked', 'tax_category_id', 'deleted_at'])
          .where('id', '=', line.productId)
          .where('tenant_id', '=', ctx.tenantId)
          .executeTakeFirst()
          .then((p) => (p && !p.deleted_at ? p : undefined));
        if (!product) {
          conflictCodes.push('DELETED_REFERENCE');
          warnings.push(`Product ${line.sku} not found or deleted; line kept from snapshot`);
        }
      }

      let taxRateBp = line.taxRateBp;
      let taxInclusive = line.taxInclusive;
      if (product?.tax_category_id) {
        const tc = await trx
          .selectFrom('tax_categories')
          .select(['rate_bp', 'inclusive'])
          .where('id', '=', product.tax_category_id)
          .executeTakeFirst();
        if (tc) {
          taxRateBp = tc.rate_bp;
          taxInclusive = tc.inclusive;
        }
      }

      const computed = computeLine({ unitPriceMinor: line.unitPriceMinor, quantity: line.quantity, discountBp: line.discountBp, taxRateBp, taxInclusive });
      const costMinor = product ? Math.round(product.cost_minor * line.quantity) : 0;
      lineRows.push({
        id: line.id,
        productId: product?.id ?? null,
        sku: product?.sku ?? line.sku,
        name: product?.name ?? line.name,
        unit: product?.unit ?? line.unit,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        discountBp: line.discountBp,
        taxRateBp,
        taxInclusive,
        discountMinor: computed.discountMinor,
        netMinor: computed.netMinor,
        taxMinor: computed.taxMinor,
        lineTotalMinor: computed.lineTotalMinor,
        costMinor,
        stockTracked: product?.is_stock_tracked ?? false,
      });
    }

    const totals = computeDocument(
      lineRows.map((l) => ({ unitPriceMinor: l.unitPriceMinor, quantity: l.quantity, discountBp: l.discountBp, taxRateBp: l.taxRateBp, taxInclusive: l.taxInclusive })),
    );
    const costTotalMinor = lineRows.reduce((s, l) => s + l.costMinor, 0);
    // The authoritative cost of goods for stock-tracked lines is the FIFO value actually consumed
    // (ADR 0009), computed below when movements are applied. The per-line snapshot is only kept
    // for non-tracked lines (services, fees) where no valuation layer exists.
    const nonTrackedCostMinor = lineRows.filter((l) => !l.stockTracked).reduce((s, l) => s + l.costMinor, 0);
    let saleCogsMinor = 0;

    // --- price-snapshot review (dated promotions + price lists, §13 pricing snapshots) -----
    // We keep the sale-time price the till actually charged and only flag divergence — whatever
    // moved underneath it (a promotion, a scheduled list flip, a branch price, the base price).
    // The branch is stated because a shelf prices itself: a device that was offline during a price
    // change must be FLAGGED here, not silently re-priced (item 4.11, architecture line 394).
    const priceAsOf = sale.clientCreatedAt ? new Date(sale.clientCreatedAt) : new Date();
    for (const l of lineRows) {
      if (!l.productId) continue;
      const resolved = await this.pricing.resolvePrice(trx, ctx.tenantId, l.productId, l.quantity, priceAsOf, ctx.branchId);
      if (resolved && resolved.unitPriceMinor !== l.unitPriceMinor) {
        warnings.push(`STALE_PRICE_SNAPSHOT ${l.sku}: charged ${l.unitPriceMinor}, policy ${resolved.unitPriceMinor}`);
      }
    }

    // --- validate tenders -----------------------------------------------------------
    const tenderSum = sale.tenders.reduce((s, t) => s + t.amountMinor, 0);
    if (tenderSum < totals.totalMinor) {
      return { status: 'review_required', result: { code: 'VALIDATION_ERROR', message: 'Tenders do not cover the sale total' }, conflictCodes: ['VALIDATION_ERROR'] };
    }
    const creditTender = sale.tenders.find((t) => t.method === 'credit');
    if (creditTender && !sale.customerId) {
      return { status: 'review_required', result: { code: 'VALIDATION_ERROR', message: 'Credit tender requires a customer' }, conflictCodes: ['VALIDATION_ERROR'] };
    }

    // --- credit exposure (offline policy, §6) --------------------------------------
    if (creditTender && sale.customerId) {
      const customer = await trx
        .selectFrom('customers')
        .select(['id', 'credit_limit_minor'])
        .where('id', '=', sale.customerId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!customer) {
        conflictCodes.push('DELETED_REFERENCE');
      } else {
        const balRow = await trx
          .selectFrom('customer_ledger_entries')
          .select(({ fn }) => [fn.coalesce(fn.sum<number>('debit_minor'), sql<number>`0`).as('debit'), fn.coalesce(fn.sum<number>('credit_minor'), sql<number>`0`).as('credit')])
          .where('tenant_id', '=', ctx.tenantId)
          .where('customer_id', '=', sale.customerId)
          .executeTakeFirst();
        const balance = Number(balRow?.debit ?? 0) - Number(balRow?.credit ?? 0);
        if (balance + creditTender.amountMinor > Number(customer.credit_limit_minor)) {
          conflictCodes.push('CREDIT_EXCEEDED');
          warnings.push('Credit limit exceeded; sale preserved and flagged for review');
        }
      }
    }

    // --- determine state ------------------------------------------------------------
    const saleState = conflictCodes.length > 0 ? 'review_required' : 'accepted';

    // --- persist sale + lines + tenders --------------------------------------------
    await trx
      .insertInto('sales')
      .values({
        id: sale.id,
        tenant_id: ctx.tenantId,
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        cash_session_id: sale.cashSessionId ?? null,
        customer_id: sale.customerId ?? null,
        actor_id: ctx.actorId,
        local_number: sale.localNumber ?? null,
        state: saleState,
        currency: sale.currency,
        subtotal_minor: totals.subtotalMinor,
        discount_minor: totals.discountTotalMinor,
        tax_total_minor: totals.taxTotalMinor,
        total_minor: totals.totalMinor,
        cost_total_minor: costTotalMinor,
        price_snapshot_version: sale.priceSnapshotVersion ?? null,
        conflict_reason: conflictCodes.length ? conflictCodes.join(',') : null,
        command_id: ctx.commandId,
        client_created_at: sale.clientCreatedAt ? new Date(sale.clientCreatedAt) : null,
      })
      .execute();

    for (const l of lineRows) {
      await trx
        .insertInto('sale_lines')
        .values({
          id: l.id,
          sale_id: sale.id,
          tenant_id: ctx.tenantId,
          product_id: l.productId,
          sku_snapshot: l.sku,
          name_snapshot: l.name,
          unit: l.unit,
          quantity: l.quantity,
          unit_price_minor: l.unitPriceMinor,
          discount_bp: l.discountBp,
          discount_minor: l.discountMinor,
          tax_rate_bp: l.taxRateBp,
          tax_inclusive: l.taxInclusive,
          net_minor: l.netMinor,
          tax_minor: l.taxMinor,
          line_total_minor: l.lineTotalMinor,
          cost_minor: l.costMinor,
          tax_snapshot_version: sale.priceSnapshotVersion ?? null,
        })
        .execute();
    }

    for (const t of sale.tenders) {
      // `recorded` vs `verified`: cash settles locally; manual references stay unverified (§2, §11).
      const isCash = t.method === 'cash';
      const status = isCash ? 'recorded' : t.externalReference ? 'unverified_reference' : 'pending';
      await trx
        .insertInto('tenders')
        .values({
          id: t.id,
          sale_id: sale.id,
          tenant_id: ctx.tenantId,
          method: t.method,
          amount_minor: t.amountMinor,
          status,
          external_reference: t.externalReference ?? null,
          verified: isCash,
        })
        .execute();
    }

    // --- stock movements (append-only) + projection ---------------------------------
    // COGS is not read from `products.cost_minor`; it comes from the FIFO layers this sale
    // actually consumes (ADR 0009).
    const trackingLines = lineRows.filter((l) => l.stockTracked && l.productId);
    if (trackingLines.length > 0) {
      const locationId = await this.inventory.getOrCreateLocation(trx, ctx.tenantId, ctx.branchId);
      const negatives: string[] = [];
      const uncosted: string[] = [];
      for (const l of trackingLines) {
        const movement = await this.inventory.applyMovement(trx, {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          locationId,
          productId: l.productId as string,
          quantityDelta: -l.quantity,
          unit: l.unit,
          reason: 'sale',
          sourceType: 'sale',
          sourceId: sale.id,
          actorId: ctx.actorId,
          deviceId: ctx.deviceId,
          commandId: ctx.commandId,
        });
        saleCogsMinor += movement.cogsMinor;
        if (movement.quantity < 0) negatives.push(l.productId as string);
        if (movement.uncostedQuantity > 0) uncosted.push(l.productId as string);
      }

      // Detect negative stock and raise a visible conflict (do not hide facts). An uncosted
      // shortfall means part of the sale has no cost basis yet — the owner must resolve it.
      if (negatives.length > 0) {
        conflictCodes.push('NEGATIVE_STOCK');
        warnings.push(`Negative stock on ${negatives.length} product(s) after independent offline sales`);
      }
      if (uncosted.length > 0) {
        conflictCodes.push('UNCOSTED_STOCK');
        warnings.push(`No cost basis for ${uncosted.length} product(s); COGS is understated until receipted`);
      }
    }

    // The server is canonical: replace the client's provisional cost estimate with the FIFO value
    // it actually consumed, so the sale row and the general ledger agree (ADR 0009).
    const canonicalCostMinor = saleCogsMinor + nonTrackedCostMinor;
    if (canonicalCostMinor !== costTotalMinor) {
      await trx.updateTable('sales').set({ cost_total_minor: canonicalCostMinor }).where('id', '=', sale.id).execute();
    }

    // --- customer AR subledger (credit tender) --------------------------------------
    if (creditTender && sale.customerId) {
      await trx
        .insertInto('customer_ledger_entries')
        .values({
          id: crypto.randomUUID(),
          tenant_id: ctx.tenantId,
          customer_id: sale.customerId,
          source_type: 'sale',
          source_id: sale.id,
          debit_minor: creditTender.amountMinor,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'source_type', 'source_id', 'customer_id']).doNothing())
        .execute();
    }

    // --- canonical journal (server-side posting, §7) --------------------------------
    const glWarning = await this.postSaleJournal(trx, ctx, sale.id, totals, saleCogsMinor + nonTrackedCostMinor, sale.tenders);
    if (glWarning) warnings.push(glWarning);

    // --- platform records -----------------------------------------------------------
    // Conflict cases for `conflictCodes` are created centrally by the sync layer so every
    // aggregate type gets identical, auditable exception handling.
    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'sale.created',
      aggregateType: 'Sale',
      aggregateId: sale.id,
      after: { totalMinor: totals.totalMinor, state: saleState },
      correlationId: ctx.correlationId,
    });
    const seq = await this.events.serverEvent(trx, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      eventType: 'sale.created',
      aggregateType: 'Sale',
      aggregateId: sale.id,
      payload: { totalMinor: totals.totalMinor, state: saleState, lineCount: lineRows.length },
    });
    await this.events.outbox(trx, ctx.tenantId, 'sale.created', { saleId: sale.id, totalMinor: totals.totalMinor });

    return {
      status: saleState === 'accepted' ? 'accepted' : 'review_required',
      result: {
        saleId: sale.id,
        serverSeq: seq,
        state: saleState,
        subtotalMinor: totals.subtotalMinor,
        taxTotalMinor: totals.taxTotalMinor,
        totalMinor: totals.totalMinor,
        warnings,
      },
      conflictCodes: Array.from(new Set(conflictCodes)),
    };
  }

  /**
   * Post a balanced journal for the sale. Returns a warning string if the chart of accounts
   * is not configured (the business effect still stands; GL is a configuration concern).
   */
  private async postSaleJournal(
    trx: Kysely<Database>,
    ctx: SaleApplyContext,
    saleId: string,
    totals: { totalMinor: number; taxTotalMinor: number; subtotalMinor: number },
    costTotalMinor: number,
    tenders: Array<{ method: string; amountMinor: number }>,
  ): Promise<string | null> {
    const accounts = await trx
      .selectFrom('chart_of_accounts')
      .select(['id', 'code'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('code', 'in', ['1000', '1100', '4000', '2100', '1300', '5000'])
      .execute();
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    const cash = byCode.get('1000');
    const ar = byCode.get('1100');
    const revenue = byCode.get('4000');
    const tax = byCode.get('2100');
    const inventory = byCode.get('1300');
    const cogs = byCode.get('5000');
    if (!cash || !ar || !revenue || !tax || !inventory || !cogs) {
      return 'GL_NOT_CONFIGURED';
    }

    const creditMinor = tenders.filter((t) => t.method === 'credit').reduce((s, t) => s + t.amountMinor, 0);
    const settledMinor = tenders.filter((t) => t.method !== 'credit').reduce((s, t) => s + t.amountMinor, 0);

    const journalId = crypto.randomUUID();
    const lines: Array<{ account_id: string; debit_minor: number; credit_minor: number; memo: string }> = [];
    if (settledMinor > 0) lines.push({ account_id: cash, debit_minor: settledMinor, credit_minor: 0, memo: 'Tender settled' });
    if (creditMinor > 0) lines.push({ account_id: ar, debit_minor: creditMinor, credit_minor: 0, memo: 'Credit sale' });
    lines.push({ account_id: revenue, debit_minor: 0, credit_minor: totals.subtotalMinor, memo: 'Sales revenue' });
    if (totals.taxTotalMinor > 0) lines.push({ account_id: tax, debit_minor: 0, credit_minor: totals.taxTotalMinor, memo: 'Tax payable' });
    if (costTotalMinor > 0) {
      lines.push({ account_id: cogs, debit_minor: costTotalMinor, credit_minor: 0, memo: 'COGS' });
      lines.push({ account_id: inventory, debit_minor: 0, credit_minor: costTotalMinor, memo: 'Inventory relief' });
    }

    const debit = lines.reduce((s, l) => s + l.debit_minor, 0);
    const credit = lines.reduce((s, l) => s + l.credit_minor, 0);
    if (debit !== credit) {
      // Should be impossible given totals; fail loudly rather than post an unbalanced journal (§7).
      this.logger.error(`Unbalanced sale journal for ${saleId}: debit=${debit} credit=${credit}`);
      throw new Error(`Unbalanced journal for sale ${saleId}`);
    }

    await trx.insertInto('journals').values({ id: journalId, tenant_id: ctx.tenantId, source_type: 'sale', source_id: saleId, memo: 'Sale posting', rule_version: 1 }).execute();
    for (const l of lines) {
      await trx.insertInto('journal_lines').values({ id: crypto.randomUUID(), journal_id: journalId, tenant_id: ctx.tenantId, account_id: l.account_id, debit_minor: l.debit_minor, credit_minor: l.credit_minor, memo: l.memo }).execute();
    }
    return null;
  }
}
