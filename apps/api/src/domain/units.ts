/**
 * Units of measure and conversion (item 4.6). Mirror of `convertQuantity` in
 * packages/domain-fixtures — keep the two identical, as the fixture vectors
 * (fixtures/unit-conversion.json, checked by scripts/check.mjs and tests/unit/unit-conversion.spec.ts)
 * require. The Kotlin and Swift ports carry the same vectors.
 *
 * Two facts decide every quantity that reaches the stock ledger:
 *   - the product's BASE unit (`products.unit`) is the only unit stock is ever held in
 *   - a conversion is expressed against that base: `factor` = how many base units one of the
 *     unit contains (1 crate of 24 bottles -> crate factor 24)
 *
 * Money stays integer minor units (§7). Quantities are not money, but they still use a strictly
 * defined fixed-precision decimal strategy: 3 decimals (numeric(18,3)), rounded half-up.
 */
export type UnitKind = 'count' | 'weight' | 'volume';

export const UNIT_KINDS: UnitKind[] = ['count', 'weight', 'volume'];

/** Ledger precision for quantities: 3 decimals, exactly what `numeric(18,3)` stores. */
export const QUANTITY_DECIMALS = 3;
export const QUANTITY_SCALE = 10 ** QUANTITY_DECIMALS;

export interface ConvertQuantityInput {
  quantity: number;
  /** How many base units one `from` unit contains. */
  fromFactor: number;
  /** How many base units one `to` unit contains. */
  toFactor: number;
  /** Kind of the BASE unit. Defaults to `count` — the strict reading. */
  kind?: UnitKind;
}

export type ConvertQuantityResult = { ok: true; quantity: number } | { ok: false; code: string };

export function convertQuantity(input: ConvertQuantityInput): ConvertQuantityResult {
  const { quantity, fromFactor, toFactor, kind = 'count' } = input;
  if (!Number.isFinite(quantity)) return { ok: false, code: 'INVALID_QUANTITY' };
  if (!Number.isFinite(fromFactor) || !Number.isFinite(toFactor) || fromFactor <= 0 || toFactor <= 0) {
    return { ok: false, code: 'INVALID_CONVERSION_FACTOR' };
  }
  const scaled = roundQuantity((quantity * fromFactor) / toFactor);
  if (!Number.isFinite(scaled)) return { ok: false, code: 'INVALID_QUANTITY' };
  if (kind === 'count' && scaled !== Math.round(scaled)) return { ok: false, code: 'FRACTIONAL_QUANTITY' };
  return { ok: true, quantity: scaled };
}

/**
 * Round to ledger precision, half-up — the same rounding rule money uses (§7), applied to
 * quantities. An operator never sees the binary residue of a conversion (12.000000000000002
 * bottles), and the ledger stores exactly what this produces.
 */
export function roundQuantity(x: number): number {
  return Math.floor(x * QUANTITY_SCALE + 0.5) / QUANTITY_SCALE;
}
