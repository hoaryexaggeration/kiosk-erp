import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/database';
import { roundHalfUp } from '../../domain/pricing';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';

export interface ResolvedPrice {
  unitPriceMinor: number;
  /** The effective LIST price before any promotion: base, or the override in force (item 4.11). */
  basePriceMinor: number;
  promotionId: string | null;
  promotionName: string | null;
  /**
   * The version of the BASE price this resolution stands on (`products.price_version`, item 4.11).
   * A sale snapshot attaches it so "which price did I charge" is answerable without diffing
   * amounts — and a description typo elsewhere on the product cannot make a price look stale.
   */
  priceVersion: number;
  /** The override row in force, if any — the caller can show WHY a shelf prices differently. */
  priceOverrideId: string | null;
  source: 'promotion' | 'override' | 'list';
}

export interface PriceOverrideInput {
  productId: string;
  /** null = the tenant-wide list (every branch); otherwise exactly this shelf. */
  branchId?: string | null;
  priceMinor: number;
  validFrom: Date;
  validTo?: Date | null;
}

export interface PriceHistoryRow {
  id: string;
  productId: string;
  branchId: string | null;
  branchName: string | null;
  oldPriceMinor: number | null;
  newPriceMinor: number;
  source: string;
  actorId: string | null;
  actorName: string | null;
  changedAt: Date;
}

/**
 * Price resolution is a pure function of (product, quantity, asOf, branch) — never of the device
 * clock at posting time. Two layers stack on the base price (§3.C):
 *
 *   1. a price LIST row — dated, optionally branch-scoped (item 4.11). Most specific scope wins
 *      (branch beats tenant-wide), then the latest `valid_from`, so a scheduled row takes over the
 *      moment its window opens, computed from cached data on any device, offline;
 *   2. a promotion — as before, figured on the effective list price of the moment.
 *
 * Promotions carry dated windows so a sale can be re-priced/reviewed against the policy that was
 * live when it was rung up (architecture §4, §13 pricing snapshots).
 */
@Injectable()
export class PricingService {
  async resolvePrice(
    trx: Kysely<Database>,
    tenantId: string,
    productId: string,
    quantity: number,
    asOf: Date,
    branchId: string | null = null,
  ): Promise<ResolvedPrice | null> {
    const product = await trx
      .selectFrom('products')
      .select(['id', 'price_minor', 'price_version', 'category_id', 'version', 'deleted_at'])
      .where('id', '=', productId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!product || product.deleted_at) return null;

    // The override in force for this shelf at this instant (item 4.11). A row for every branch
    // (branch_id null) loses to a row naming this one; ties go to the later window.
    const overrides = await trx
      .selectFrom('product_price_overrides')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('product_id', '=', productId)
      .where((eb) => (branchId ? eb.or([eb('branch_id', 'is', null), eb('branch_id', '=', branchId)]) : eb('branch_id', 'is', null)))
      .where('valid_from', '<=', asOf)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', asOf)]))
      .execute();
    const override = overrides
      .slice()
      .sort((a, b) => {
        const scope = Number(b.branch_id !== null) - Number(a.branch_id !== null);
        if (scope !== 0) return scope;
        const from = b.valid_from.getTime() - a.valid_from.getTime();
        if (from !== 0) return from;
        return b.created_at.getTime() - a.created_at.getTime();
      })[0] ?? null;

    const candidates = await trx
      .selectFrom('promotions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('is_active', '=', true)
      .where((eb) =>
        eb.or([
          eb('product_id', '=', productId),
          product.category_id ? eb('category_id', '=', product.category_id) : eb.val(false),
        ]),
      )
      .where((eb) => eb.or([eb('starts_at', 'is', null), eb('starts_at', '<=', asOf)]))
      .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', asOf)]))
      .execute();

    // Prefer the most specific promotion (product beats category), then the most recent.
    const chosen = candidates
      .slice()
      .sort((a, b) => {
        const specificity = Number(b.product_id !== null) - Number(a.product_id !== null);
        if (specificity !== 0) return specificity;
        return b.created_at.getTime() - a.created_at.getTime();
      })[0];

    const base = Number(override ? override.price_minor : product.price_minor);
    if (!chosen) {
      return {
        unitPriceMinor: base,
        basePriceMinor: base,
        promotionId: null,
        promotionName: null,
        priceVersion: product.price_version,
        priceOverrideId: override?.id ?? null,
        source: override ? 'override' : 'list',
      };
    }

    let resolved = base;
    if (chosen.kind === 'percent_off') {
      resolved = roundHalfUp((base * (10000 - chosen.value)) / 10000);
    } else if (chosen.kind === 'amount_off') {
      resolved = Math.max(0, base - chosen.value);
    } else if (chosen.kind === 'fixed_price') {
      resolved = chosen.value;
    }
    void quantity; // quantity tiers are a later refinement; kept in the signature deliberately.

    return {
      unitPriceMinor: resolved,
      basePriceMinor: base,
      promotionId: chosen.id,
      promotionName: chosen.name,
      priceVersion: product.price_version,
      priceOverrideId: override?.id ?? null,
      source: 'promotion',
    };
  }

  // --- price lists (item 4.11) --------------------------------------------------------------

  /** Every override of one product, newest window first, with the branch named for display. */
  async listOverrides(trx: Kysely<Database>, tenantId: string, productId: string) {
    const rows = await trx
      .selectFrom('product_price_overrides')
      .leftJoin('branches', 'branches.id', 'product_price_overrides.branch_id')
      .select([
        'product_price_overrides.id',
        'product_price_overrides.product_id',
        'product_price_overrides.branch_id',
        'branches.name as branch_name',
        'product_price_overrides.price_minor',
        'product_price_overrides.valid_from',
        'product_price_overrides.valid_to',
        'product_price_overrides.created_at',
      ])
      .where('product_price_overrides.tenant_id', '=', tenantId)
      .where('product_price_overrides.product_id', '=', productId)
      .orderBy('product_price_overrides.valid_from', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      product_id: row.product_id,
      branch_id: row.branch_id,
      branch_name: row.branch_name ?? null,
      price_minor: Number(row.price_minor),
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      created_at: row.created_at,
    }));
  }

  /**
   * Create a price-list row. The write and its history land in the SAME transaction — history that
   * can be appended to afterwards is history nobody trusts (§3.C).
   */
  async createOverride(trx: Kysely<Database>, tenantId: string, actorId: string, input: PriceOverrideInput) {
    const product = await trx
      .selectFrom('products')
      .select(['id', 'price_minor'])
      .where('id', '=', input.productId)
      .where('tenant_id', '=', tenantId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
    if (input.branchId) {
      const branch = await trx.selectFrom('branches').select('id').where('id', '=', input.branchId).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!branch) throw AppError.validation('Unknown branch');
    }
    if (input.validTo && input.validTo <= input.validFrom) throw AppError.validation('validTo must be after validFrom');

    const id = newId();
    await trx
      .insertInto('product_price_overrides')
      .values({
        id,
        tenant_id: tenantId,
        product_id: input.productId,
        branch_id: input.branchId ?? null,
        price_minor: input.priceMinor,
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
        created_by: actorId,
      })
      .execute();
    await this.recordPriceChange(trx, {
      tenantId,
      productId: input.productId,
      branchId: input.branchId ?? null,
      oldPriceMinor: null,
      newPriceMinor: input.priceMinor,
      source: 'override',
      actorId,
    });
    return id;
  }

  async updateOverride(
    trx: Kysely<Database>,
    tenantId: string,
    actorId: string,
    overrideId: string,
    input: Partial<PriceOverrideInput>,
  ) {
    const current = await trx
      .selectFrom('product_price_overrides')
      .selectAll()
      .where('id', '=', overrideId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!current) throw AppError.notFound('OVERRIDE_NOT_FOUND', 'Price override not found');

    const validFrom = input.validFrom ?? current.valid_from;
    const validTo = input.validTo === undefined ? current.valid_to : input.validTo;
    if (validTo && validTo <= validFrom) throw AppError.validation('validTo must be after validFrom');
    if (input.branchId) {
      const branch = await trx.selectFrom('branches').select('id').where('id', '=', input.branchId).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!branch) throw AppError.validation('Unknown branch');
    }

    const priceMinor = input.priceMinor ?? Number(current.price_minor);
    await trx
      .updateTable('product_price_overrides')
      .set({
        branch_id: input.branchId === undefined ? current.branch_id : input.branchId ?? null,
        price_minor: priceMinor,
        valid_from: validFrom,
        valid_to: validTo,
      })
      .where('id', '=', overrideId)
      .where('tenant_id', '=', tenantId)
      .execute();
    if (priceMinor !== Number(current.price_minor)) {
      await this.recordPriceChange(trx, {
        tenantId,
        productId: current.product_id,
        branchId: input.branchId === undefined ? current.branch_id : input.branchId ?? null,
        oldPriceMinor: Number(current.price_minor),
        newPriceMinor: priceMinor,
        source: 'override',
        actorId,
      });
    }
  }

  /**
   * Removing a row is a price change too — the shelf falls back to the base price — so it is
   * recorded as exactly that, never as a silent disappearance from the list.
   */
  async deleteOverride(trx: Kysely<Database>, tenantId: string, actorId: string, overrideId: string) {
    const current = await trx
      .selectFrom('product_price_overrides')
      .selectAll()
      .where('id', '=', overrideId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!current) throw AppError.notFound('OVERRIDE_NOT_FOUND', 'Price override not found');
    const product = await trx
      .selectFrom('products')
      .select('price_minor')
      .where('id', '=', current.product_id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    await trx.deleteFrom('product_price_overrides').where('id', '=', overrideId).where('tenant_id', '=', tenantId).execute();
    await this.recordPriceChange(trx, {
      tenantId,
      productId: current.product_id,
      branchId: current.branch_id,
      oldPriceMinor: Number(current.price_minor),
      newPriceMinor: product ? Number(product.price_minor) : Number(current.price_minor),
      source: 'override_removed',
      actorId,
    });
  }

  /** Price-change history (item 4.11), newest first, actor named for the audit trail. */
  async history(trx: Kysely<Database>, tenantId: string, productId: string, limit = 100): Promise<PriceHistoryRow[]> {
    const rows = await trx
      .selectFrom('price_change_history')
      .leftJoin('users', 'users.id', 'price_change_history.actor_id')
      .leftJoin('branches', 'branches.id', 'price_change_history.branch_id')
      .select([
        'price_change_history.id',
        'price_change_history.product_id',
        'price_change_history.branch_id',
        'branches.name as branch_name',
        'price_change_history.old_price_minor',
        'price_change_history.new_price_minor',
        'price_change_history.source',
        'price_change_history.actor_id',
        'users.display_name as actor_name',
        'price_change_history.changed_at',
      ])
      .where('price_change_history.tenant_id', '=', tenantId)
      .where('price_change_history.product_id', '=', productId)
      .orderBy('price_change_history.changed_at', 'desc')
      .orderBy('price_change_history.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      branchId: row.branch_id,
      branchName: row.branch_name ?? null,
      oldPriceMinor: row.old_price_minor === null ? null : Number(row.old_price_minor),
      newPriceMinor: Number(row.new_price_minor),
      source: row.source,
      actorId: row.actor_id,
      actorName: row.actor_name ?? null,
      changedAt: row.changed_at,
    }));
  }

  /**
   * One append-only history row, called INSIDE the write's own transaction by this service and by
   * the catalogue (base-price edits, imports). `oldPriceMinor` null means the price is new.
   */
  async recordPriceChange(
    trx: Kysely<Database>,
    entry: {
      tenantId: string;
      productId: string;
      branchId: string | null;
      oldPriceMinor: number | null;
      newPriceMinor: number;
      source: 'edit' | 'import' | 'override' | 'override_removed';
      actorId: string | null;
    },
  ) {
    await trx
      .insertInto('price_change_history')
      .values({
        id: newId(),
        tenant_id: entry.tenantId,
        product_id: entry.productId,
        branch_id: entry.branchId,
        old_price_minor: entry.oldPriceMinor,
        new_price_minor: entry.newPriceMinor,
        source: entry.source,
        actor_id: entry.actorId,
      })
      .execute();
  }
}
