import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeLine, computeDocument, roundHalfUp } from '../../src/domain/pricing';

/**
 * Guarantees the TypeScript implementation produces the SAME results as the language-neutral
 * fixtures used by the Kotlin (and later Swift) clients. A mismatch here is a cross-client
 * correctness bug (architecture §5, §16 layer 4).
 */
const FIXTURES = join(__dirname, '../../../..', 'packages/domain-fixtures/fixtures');

describe('domain fixtures conformance (TypeScript)', () => {
  it('rounds half-up identically', () => {
    expect(roundHalfUp(159.84)).toBe(160);
    expect(roundHalfUp(0.16)).toBe(0);
    expect(roundHalfUp(2.5)).toBe(3);
  });

  it('matches every pricing line vector', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'pricing-tax.json'), 'utf8'));
    for (const c of data.lines) {
      expect({ id: c.id, ...computeLine(c.input) }).toEqual({ id: c.id, ...c.expected });
    }
  });

  it('matches every pricing document vector', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'pricing-tax.json'), 'utf8'));
    for (const d of data.documents) {
      const { subtotalMinor, taxTotalMinor, totalMinor } = computeDocument(d.lines);
      expect({ subtotalMinor, taxTotalMinor, totalMinor }).toEqual(d.expected);
    }
  });
});
