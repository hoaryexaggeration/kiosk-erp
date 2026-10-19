import { parseCsv } from '../../src/domain/csv';
import {
  OpeningStockProduct,
  OpeningStockReference,
  planOpeningStockImport,
  recordsToCsvRows,
} from '../../src/modules/inventory/opening-stock-import';

/**
 * Opening-stock import (item 4.5) is tested as a pure function: no database, no HTTP. The claim
 * under test is the one the phase states — opening balances are planned as MOVEMENTS (a quantity
 * before, a quantity after, a cost, a value) and never as an edit to a stored quantity.
 */
const csv = (text: string) => parseCsv(text);

const product = (over: Partial<OpeningStockProduct> & { id: string; sku: string }): OpeningStockProduct => ({
  name: over.sku,
  unit: 'ea',
  costMinor: 1000,
  isStockTracked: true,
  ...over,
});

const sugar = product({ id: '88888888-8888-4888-8888-888888888803', sku: 'SKU-003', name: 'Sugar 1kg', costMinor: 14500 });

const reference = (overrides: Partial<OpeningStockReference> = {}): OpeningStockReference => ({
  productsBySku: new Map([['sku-003', sugar]]),
  ambiguousSkus: new Set(),
  onHandByProduct: new Map(),
  productsWithOpening: new Set(),
  branchAlreadyTrading: false,
  ...overrides,
});

describe('opening-stock import planner (Phase 4, item 4.5)', () => {
  it('plans a valid row as a movement: on-hand before, quantity to add, on-hand after', () => {
    const plan = planOpeningStockImport(csv('sku,quantity\nSKU-003,40'), reference());
    expect(plan.errors).toEqual([]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      sku: 'SKU-003',
      quantity: 40,
      onHandBefore: 0,
      onHandAfter: 40,
      unitCostMinor: 14500,
      costWasGiven: false,
      valueMinor: 40 * 14500,
    });
    expect(plan.totalQuantity).toBe(40);
    expect(plan.totalValueMinor).toBe(40 * 14500);
  });

  it('reads the existing balance so the report shows what the movement will change', () => {
    const plan = planOpeningStockImport(
      csv('sku,qty\nSKU-003,10'),
      reference({ onHandByProduct: new Map([[sugar.id, 24]]) }),
    );
    expect(plan.rows[0].onHandBefore).toBe(24);
    expect(plan.rows[0].onHandAfter).toBe(34);
  });

  it('accepts a fractional quantity (weighed goods) but never a negative or zero one', () => {
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-003,12.5'), reference()).rows[0].quantity).toBe(12.5);
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-003,-4'), reference()).errors[0].code).toBe('INVALID_QUANTITY');
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-003,0'), reference()).errors[0].code).toBe('QUANTITY_NOT_POSITIVE');
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-003,abc'), reference()).errors[0].code).toBe('INVALID_QUANTITY');
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-003,1 2'), reference()).errors[0].code).toBe('INVALID_QUANTITY');
  });

  it('takes an explicit unit cost from the file and marks it as the file’s own', () => {
    const plan = planOpeningStockImport(csv('sku,quantity,unit_cost\nSKU-003,10,150'), reference());
    expect(plan.rows[0].unitCostMinor).toBe(15000);
    expect(plan.rows[0].costWasGiven).toBe(true);
    expect(plan.rows[0].valueMinor).toBe(150000);
  });

  it('rejects an over-precise cost rather than rounding it (§7)', () => {
    const plan = planOpeningStockImport(csv('sku,quantity,unit_cost\nSKU-003,10,45.999'), reference());
    expect(plan.errors).toEqual([
      expect.objectContaining({ field: 'unit_cost', code: 'INVALID_UNIT_COST', sku: 'SKU-003' }),
    ]);
    expect(plan.rows).toHaveLength(0);
  });

  it('rejects a missing or unknown column loudly — a typo must not import a zero', () => {
    expect(planOpeningStockImport(csv('sku\nSKU-003'), reference()).errors[0]).toMatchObject({
      code: 'MISSING_COLUMN',
      field: 'quantity',
    });
    expect(planOpeningStockImport(csv('sku,quantity,qty\nSKU-003,1,2'), reference()).errors[0]).toMatchObject({
      code: 'DUPLICATE_COLUMN',
      field: 'quantity',
    });
    const unknown = planOpeningStockImport(csv('sku,quantity,costt\nSKU-003,1,9'), reference());
    expect(unknown.errors[0]).toMatchObject({ code: 'UNKNOWN_COLUMN', field: 'costt' });
    // The file still has to be read as unusable rather than half-used.
    expect(unknown.rows).toHaveLength(0);
  });

  it('reports an unknown SKU, an ambiguous one and one that is not stock-tracked', () => {
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-999,1'), reference()).errors[0]).toMatchObject({
      code: 'UNKNOWN_SKU',
      sku: 'SKU-999',
    });

    const ambiguous = planOpeningStockImport(csv('sku,quantity\nSKU-003,1'), reference({ ambiguousSkus: new Set(['sku-003']) }));
    expect(ambiguous.errors[0].code).toBe('AMBIGUOUS_SKU');

    const untracked = reference({
      productsBySku: new Map([['sku-019', product({ id: '88888888-8888-4888-8888-888888888819', sku: 'SKU-019', isStockTracked: false })]]),
    });
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-019,1'), untracked).errors[0]).toMatchObject({
      code: 'PRODUCT_NOT_STOCK_TRACKED',
      sku: 'SKU-019',
    });
  });

  it('finds every bad row, not just the first — one plan for the whole file', () => {
    const plan = planOpeningStockImport(csv('sku,quantity\nSKU-999,1\nSKU-003,0\n,5\nSKU-003,abc'), reference());
    expect(plan.errors.map((error) => error.code)).toEqual([
      'UNKNOWN_SKU',
      'QUANTITY_NOT_POSITIVE',
      'MISSING_SKU',
      'INVALID_QUANTITY',
    ]);
    expect(plan.errors.map((error) => error.line)).toEqual([2, 3, 4, 5]);
    expect(plan.rows).toHaveLength(0);
  });

  it('refuses a duplicated SKU so the second line cannot silently double the count', () => {
    const plan = planOpeningStockImport(csv('sku,quantity\nSKU-003,10\nSKU-003,20'), reference());
    expect(plan.errors[0]).toMatchObject({ code: 'DUPLICATE_SKU_IN_FILE', line: 3 });
    expect(plan.rows).toHaveLength(1);
  });

  it('flags a row wider than the header — an unescaped comma shifted the columns', () => {
    const plan = planOpeningStockImport(csv('sku,quantity\nSKU-003,1,extra'), reference());
    expect(plan.errors[0]).toMatchObject({ code: 'RAGGED_ROW', line: 2 });
    expect(plan.rows).toHaveLength(0);
  });

  it('warns — without blocking — when opening stock for the product is already present', () => {
    const plan = planOpeningStockImport(csv('sku,quantity\nSKU-003,10'), reference({
      onHandByProduct: new Map([[sugar.id, 24]]),
      productsWithOpening: new Set([sugar.id]),
    }));
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([
      expect.objectContaining({ code: 'OPENING_ALREADY_PRESENT', sku: 'SKU-003', line: 2 }),
    ]);
    expect(plan.warnings[0].message).toContain('24 → 34');
  });

  it('warns when a cost is unknown so opening stock is never silently valued at zero', () => {
    const plan = planOpeningStockImport(
      csv('sku,quantity\nSKU-003,10'),
      reference({ productsBySku: new Map([['sku-003', product({ ...sugar, costMinor: 0 })]]) }),
    );
    expect(plan.warnings[0].code).toBe('OPENING_COST_UNKNOWN');
    expect(plan.rows[0].unitCostMinor).toBe(0);
  });

  it('warns at file level when the branch has already traded', () => {
    const plan = planOpeningStockImport(csv('sku,quantity\nSKU-003,10'), reference({ branchAlreadyTrading: true }));
    expect(plan.errors).toEqual([]);
    expect(plan.warnings[0]).toMatchObject({ code: 'BRANCH_ALREADY_TRADING', line: 1, sku: null });
    // Still an advisory: the operator, not the server, decides whether to go ahead.
    expect(plan.rows).toHaveLength(1);
  });

  it('plans an empty or header-only file as a reportable problem rather than a no-op success', () => {
    expect(planOpeningStockImport([], reference()).errors[0].code).toBe('EMPTY_FILE');
    expect(planOpeningStockImport(csv('sku,quantity'), reference()).errors[0].code).toBe('EMPTY_FILE');
  });

  it('plans JSON records through the same vocabulary as a CSV file', () => {
    const fromRecords = planOpeningStockImport(recordsToCsvRows([{ sku: 'SKU-003', quantity: 5, unit_cost: 150 }]), reference());
    const fromCsv = planOpeningStockImport(csv('sku,quantity,unit_cost\nSKU-003,5,150'), reference());
    expect(fromRecords.rows).toEqual(fromCsv.rows);
    expect(fromRecords.errors).toEqual(fromCsv.errors);
    expect(fromRecords.rows[0]).toMatchObject({ quantity: 5, unitCostMinor: 15000, costWasGiven: true });
  });

  it('rejects a record whose quantity is not a number instead of coercing it', () => {
    const plan = planOpeningStockImport(recordsToCsvRows([{ sku: 'SKU-003', quantity: 'ten' }]), reference());
    expect(plan.errors[0].code).toBe('INVALID_QUANTITY');
    expect(plan.rows).toHaveLength(0);
  });
});
