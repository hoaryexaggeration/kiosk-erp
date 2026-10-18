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
export function computeDocument(lines) {
  let subtotalMinor = 0;
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
