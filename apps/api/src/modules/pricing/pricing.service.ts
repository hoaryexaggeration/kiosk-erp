import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/database';
import { roundHalfUp } from '../../domain/pricing';

export interface ResolvedPrice {
  unitPriceMinor: number;
  basePriceMinor: number;
  promotionId: string | null;
  promotionName: string | null;
  priceVersion: number;
  source: 'promotion' | 'list';
}

/**
 * Price resolution is a pure function of (product, quantity, asOf) — never of the device clock at
 * posting time. Promotions carry dated windows so a sale can be re-priced/reviewed against the
 * policy that was live when it was rung up (architecture §4, §13 pricing snapshots).
 */
@Injectable()
export class PricingService {
  async resolvePrice(
    trx: Kysely<Database>,
    tenantId: string,
    productId: string,
    quantity: number,
    asOf: Date,
  ): Promise<ResolvedPrice | null> {
    const product = await trx
      .selectFrom('products')
      .select(['id', 'price_minor', 'category_id', 'version', 'deleted_at'])
      .where('id', '=', productId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!product || product.deleted_at) return null;

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

    const base = Number(product.price_minor);
    if (!chosen) {
      return {
        unitPriceMinor: base,
        basePriceMinor: base,
        promotionId: null,
        promotionName: null,
        priceVersion: product.version,
        source: 'list',
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
      priceVersion: product.version,
      source: 'promotion',
    };
  }
}
