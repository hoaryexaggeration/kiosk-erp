/**
 * Server-authoritative pricing/tax subset. MUST produce identical results to
 * packages/domain-fixtures (verified by tests/unit/domain-fixtures.spec.ts) and to the Kotlin port.
 * Money = integer minor units; rates = basis points; rounding = half-up per line.
 */
export interface LineInput {
  unitPriceMinor: number;
  quantity: number;
  discountBp?: number;
  taxRateBp?: number;
  taxInclusive?: boolean;
}

export interface LineResult {
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  taxMinor: number;
  lineTotalMinor: number;
}

export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

export function computeLine(input: LineInput): LineResult {
  const { unitPriceMinor, quantity, discountBp = 0, taxRateBp = 0, taxInclusive = false } = input;
  const grossMinor = unitPriceMinor * quantity;
  const discountMinor = roundHalfUp((grossMinor * discountBp) / 10000);
  const netBeforeTaxMinor = grossMinor - discountMinor;

  if (taxInclusive) {
    const taxMinor = roundHalfUp((netBeforeTaxMinor * taxRateBp) / (10000 + taxRateBp));
    return { grossMinor, discountMinor, netMinor: netBeforeTaxMinor - taxMinor, taxMinor, lineTotalMinor: netBeforeTaxMinor };
  }
  const taxMinor = roundHalfUp((netBeforeTaxMinor * taxRateBp) / 10000);
  return { grossMinor, discountMinor, netMinor: netBeforeTaxMinor, taxMinor, lineTotalMinor: netBeforeTaxMinor + taxMinor };
}

export function computeDocument(lines: LineInput[]) {  let subtotalMinor = 0;
  let taxTotalMinor = 0;
  let totalMinor = 0;
  let discountTotalMinor = 0;
  for (const line of lines) {
    const r = computeLine(line);
    subtotalMinor += r.netMinor;
    taxTotalMinor += r.taxMinor;
    totalMinor += r.lineTotalMinor;
    discountTotalMinor += r.discountMinor;
  }
  return { subtotalMinor, taxTotalMinor, totalMinor, discountTotalMinor };
}

/**
 * Parse an operator-typed money amount into integer minor units, exactly. Mirror of
 * `parseMinorInput` in packages/domain-fixtures (keep the two identical, as the fixture vectors do).
 *
 * Money never passes through binary floating point (§7): `parseFloat("1.15") * 100` is
 * 114.99999999999999 and would silently lose a cent. Over-precise input is rejected rather than
 * rounded, because quietly rounding a typed price is a money error.
 *
 * @returns minor units, or null when the input is not a valid amount
 */
export function parseMinorInput(text: string): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/,/g, '').replace(/\s/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const cents = (fraction + '00').slice(0, 2);
  const value = Number(whole) * 100 + Number(cents);
  return Number.isSafeInteger(value) ? value : null;
}
