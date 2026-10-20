/**
 * Reference implementation of the deterministic pricing/tax subset.
 * Money = integer minor units. Rates = basis points. Rounding = half-up per line.
 * This is the canonical algorithm; Kotlin (and later Swift) must pass the same fixtures.
 */

/** Round half-up for non-negative values. */
export function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

/**
 * @param {{unitPriceMinor:number, quantity:number, discountBp?:number, taxRateBp?:number, taxInclusive?:boolean}} input
 */
export function computeLine(input) {
  const {
    unitPriceMinor,
    quantity,
    discountBp = 0,
    taxRateBp = 0,
    taxInclusive = false,
  } = input;

  const grossMinor = unitPriceMinor * quantity;
  const discountMinor = roundHalfUp((grossMinor * discountBp) / 10000);
  const netBeforeTaxMinor = grossMinor - discountMinor;

  if (taxInclusive) {
    const taxMinor = roundHalfUp((netBeforeTaxMinor * taxRateBp) / (10000 + taxRateBp));
    const netMinor = netBeforeTaxMinor - taxMinor;
    return { grossMinor, discountMinor, netMinor, taxMinor, lineTotalMinor: netBeforeTaxMinor };
  }

  const netMinor = netBeforeTaxMinor;
  const taxMinor = roundHalfUp((netMinor * taxRateBp) / 10000);
  return { grossMinor, discountMinor, netMinor, taxMinor, lineTotalMinor: netMinor + taxMinor };
}

/** Sum a document from its lines. */
export function computeDocument(lines) {  let subtotalMinor = 0;
  let taxTotalMinor = 0;
  let totalMinor = 0;
  for (const line of lines) {
    const r = computeLine(line);
    subtotalMinor += r.netMinor;
    taxTotalMinor += r.taxMinor;
    totalMinor += r.lineTotalMinor;
  }
  return { subtotalMinor, taxTotalMinor, totalMinor };
}

/**
 * Offline credit exposure policy. See fixtures/credit-exposure.json.
 * @param {{online:boolean, creditLimitMinor:number, currentBalanceMinor:number, offlineCapMinor:number, newSaleMinor:number}} input
 * @returns {'allowed'|'review_required'}
 */
export function evaluateCredit(input) {
  const { online, creditLimitMinor, currentBalanceMinor, offlineCapMinor, newSaleMinor } = input;
  if (!online && newSaleMinor > offlineCapMinor) return 'review_required';
  if (currentBalanceMinor + newSaleMinor > creditLimitMinor) return 'review_required';
  return 'allowed';
}

/** @returns {boolean} whether `to` is a permitted transition from `from`. */
export function canTransition(transitions, from, to) {
  const allowed = transitions[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Parse an operator-typed money amount into integer minor units, exactly.
 *
 * Money is never allowed to pass through binary floating point (§7), so this is string/integer
 * arithmetic only — `parseFloat("1.15") * 100` is 114.99999999999999 and would lose a cent.
 * Over-precise input (more than two decimals) is REJECTED rather than silently rounded: rounding
 * someone's typed price without telling them is exactly the kind of quiet money error §7 forbids.
 *
 * @param {string} text e.g. "65", "65.5", "1,234.56" (thousands separators are stripped)
 * @returns {number|null} minor units, or null when the input is not a valid amount
 */
export function parseMinorInput(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/,/g, '').replace(/\s/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const cents = (fraction + '00').slice(0, 2);
  const value = Number(whole) * 100 + Number(cents);
  return Number.isSafeInteger(value) ? value : null;
}

/** Ledger precision: quantities are fixed-point at 3 decimals (numeric(18,3)), never money. */
export const QUANTITY_DECIMALS = 3;
export const QUANTITY_SCALE = 10 ** QUANTITY_DECIMALS;

/**
 * Convert a quantity from one unit of a product into another unit of the same product.
 *
 * Item 4.6 — "buying in crates and selling in pieces keeps one stock ledger". Both factors are
 * expressed RELATIVE TO THE PRODUCT'S BASE UNIT: `fromFactor` is how many base units one `from`
 * unit contains, `toFactor` how many one `to` unit contains. Selling in pieces and buying in
 * crates is therefore the same arithmetic in both directions, and there is exactly one place
 * where a crate becomes 24 pieces.
 *
 * Rules:
 * - the result is rounded half-up to 3 decimals — the ledger's fixed precision (§7's "strictly
 *   defined fixed-precision decimal strategy" for quantities; money itself stays integer minor units)
 * - a `count` base unit must stay a WHOLE number: 1.3 crates of 24 is 31.2 bottles, which is not a
 *   fact anyone can receive, so it is refused rather than rounded to 31 or 31.2
 * - `weight` and `volume` bases may be fractional (0.5 kg of tomatoes is exactly what was weighed)
 * - `toFactor`/`fromFactor` must be positive and finite; anything else is refused, never guessed
 *
 * @param {{quantity:number, fromFactor:number, toFactor:number, kind?:'count'|'weight'|'volume'}} input
 * @returns {{ok:true, quantity:number}|{ok:false, code:string}} a failure carries a STABLE code the
 *   caller turns into a message; messages are not part of the conformance contract.
 */
export function convertQuantity(input) {
  const { quantity, fromFactor, toFactor, kind = 'count' } = input ?? {};
  if (!Number.isFinite(quantity)) return { ok: false, code: 'INVALID_QUANTITY' };
  if (!Number.isFinite(fromFactor) || !Number.isFinite(toFactor) || fromFactor <= 0 || toFactor <= 0) {
    return { ok: false, code: 'INVALID_CONVERSION_FACTOR' };
  }
  const scaled = roundHalfUp(((quantity * fromFactor) / toFactor) * QUANTITY_SCALE) / QUANTITY_SCALE;
  if (!Number.isFinite(scaled)) return { ok: false, code: 'INVALID_QUANTITY' };
  if (kind === 'count' && scaled !== Math.round(scaled)) return { ok: false, code: 'FRACTIONAL_QUANTITY' };
  return { ok: true, quantity: scaled };
}
