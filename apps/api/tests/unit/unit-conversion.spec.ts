import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertQuantity, roundQuantity, QUANTITY_SCALE } from '../../src/domain/units';

/**
 * Guarantees the TypeScript unit-conversion implementation produces the SAME results as the
 * language-neutral fixture vectors the Kotlin (and Swift) ports are checked against — an item-4.6
 * divergence here would silently split one stock ledger across two crates-and-pieces worlds
 * (architecture §5, §16 layer 4).
 */
const FIXTURES = join(__dirname, '../../../..', 'packages/domain-fixtures/fixtures');

describe('unit conversion fixtures conformance (TypeScript)', () => {
  it('matches every conversion vector', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'unit-conversion.json'), 'utf8'));
    for (const c of data.cases) {
      expect({ id: c.id, ...convertQuantity(c.input) }).toEqual({ id: c.id, ...c.expected });
    }
  });

  it('rounds to ledger precision (3 decimals), half-up', () => {
    expect(QUANTITY_SCALE).toBe(1000);
    expect(roundQuantity(12.000000000000002)).toBe(12);
    expect(roundQuantity(0.0005)).toBe(0.001);
    expect(roundQuantity(2.5)).toBe(2.5); // already at ledger precision — quantities are not money
    expect(roundQuantity(0.0025)).toBe(0.003);
    expect(roundQuantity(-0.0025)).toBe(-0.002); // same half-up rule money uses
  });

  it('refuses a quantity that is not a finite number', () => {
    expect(convertQuantity({ quantity: Number.NaN, fromFactor: 1, toFactor: 1 })).toEqual({
      ok: false,
      code: 'INVALID_QUANTITY',
    });
    expect(convertQuantity({ quantity: Number.POSITIVE_INFINITY, fromFactor: 1, toFactor: 1 })).toEqual({
      ok: false,
      code: 'INVALID_QUANTITY',
    });
  });

  it('refuses a conversion factor that could not describe a pack', () => {
    expect(convertQuantity({ quantity: 1, fromFactor: 0, toFactor: 1 })).toEqual({
      ok: false,
      code: 'INVALID_CONVERSION_FACTOR',
    });
    expect(convertQuantity({ quantity: 1, fromFactor: 24, toFactor: Number.NaN })).toEqual({
      ok: false,
      code: 'INVALID_CONVERSION_FACTOR',
    });
  });

  it('keeps a counted base whole and lets a weighed base be fractional', () => {
    expect(convertQuantity({ quantity: 1.5, fromFactor: 1, toFactor: 1, kind: 'count' })).toEqual({
      ok: false,
      code: 'FRACTIONAL_QUANTITY',
    });
    expect(convertQuantity({ quantity: 1.5, fromFactor: 1, toFactor: 1, kind: 'weight' })).toEqual({
      ok: true,
      quantity: 1.5,
    });
  });
});
