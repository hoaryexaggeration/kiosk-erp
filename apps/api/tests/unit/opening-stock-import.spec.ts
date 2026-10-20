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
  // The base unit is counted, so a converted quantity must stay whole; `conversions` below decides
  // which packs this product may be written in (item 4.6).
  unitKind: 'count',
  conversions: new Map<string, number>(),
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
    // Weighed goods are the reason quantities are decimals at all: 12.5 kg is a normal thing to
    // receive, and `kg` is a unit that says so (item 4.6). Sugar is counted, so it is not the
    // product this claim can be made about — `12.5` of a counted base is its own test below.
    const tomatoes = product({
      id: '88888888-8888-4888-8888-888888888811',
      sku: 'SKU-011',
      name: 'Tomatoes',
      unit: 'kg',
      unitKind: 'weight',
    });
    const weighed = reference({ productsBySku: new Map([['sku-011', tomatoes]]) });
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-011,12.5'), weighed).rows[0].quantity).toBe(12.5);
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-011,-4'), weighed).errors[0].code).toBe('INVALID_QUANTITY');
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-011,0'), weighed).errors[0].code).toBe('QUANTITY_NOT_POSITIVE');
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-011,abc'), weighed).errors[0].code).toBe('INVALID_QUANTITY');
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-011,1 2'), weighed).errors[0].code).toBe('INVALID_QUANTITY');
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

/**
 * The `unit` column (item 4.6). A shop that buys in crates and sells in pieces writes opening stock
 * the way the paperwork reads, and the plan — preview AND commit, one function — decides how each
 * quantity becomes the base unit the ledger holds stock in.
 */
describe('opening-stock import: a unit column (item 4.6)', () => {
  const crates = product({ ...sugar, conversions: new Map([['crate', 24]]) });
  const asCrates = (lines: string[], products = new Map([['sku-003', crates]])) =>
    planOpeningStockImport(csv(lines.join('\n')), reference({ productsBySku: products }));

  it('converts a pack quantity into the base unit the stock is held in', () => {
    // `unit_cost` is money in the file's own major units, exactly as without a unit column:
    // 240.00 a crate is 24,000 minor, so 10 crates are 240,000 minor whichever way they are written.
    const plan = asCrates(['sku,quantity,unit_cost,unit', 'SKU-003,10,240,crate']);
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0]).toMatchObject({
      unit: 'ea',
      quantity: 240,
      enteredUnit: 'crate',
      enteredQuantity: 10,
      unitCostMinor: 1000,
      valueMinor: 240000,
      onHandAfter: 240,
    });
    // What the supplier invoiced: 10 crates × KES 240 a crate. The ledger's value can never
    // disagree with the paperwork because both travel down the same factor.
    expect(plan.totalQuantity).toBe(240);
    expect(plan.totalValueMinor).toBe(10 * 24000);
  });

  it('leaves the product’s own recorded cost alone — it is already per base unit', () => {
    const plan = asCrates(['sku,quantity,unit', 'SKU-003,10,crate']);
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ quantity: 240, unitCostMinor: sugar.costMinor, valueMinor: 240 * sugar.costMinor });
  });

  it('treats the base unit spelled out as no conversion at all', () => {
    const plan = asCrates(['sku,quantity,unit', 'SKU-003,10,ea']);
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ quantity: 10, enteredUnit: null, enteredQuantity: null });
  });

  it('refuses a pack the product has never been defined in instead of counting it as the base unit', () => {
    const plan = asCrates(['sku,quantity,unit', 'SKU-003,10,sack']);
    expect(plan.errors).toMatchObject([{ code: 'UNKNOWN_CONVERSION', field: 'unit', sku: 'SKU-003' }]);
    expect(plan.rows).toHaveLength(0);
  });

  it('refuses a counted quantity that would become a fraction — 1.3 crates is not 31 bottles', () => {
    const plan = asCrates(['sku,quantity,unit', 'SKU-003,1.3,crate']);
    expect(plan.errors[0].code).toBe('FRACTIONAL_QUANTITY');
    expect(plan.rows).toHaveLength(0);
  });

  it('lets a weighed base be fractional where a counted one is refused', () => {
    const tomatoes = product({
      id: '88888888-8888-4888-8888-888888888811',
      sku: 'SKU-011',
      name: 'Tomatoes',
      unit: 'kg',
      unitKind: 'weight',
      conversions: new Map([['g', 0.001]]),
      costMinor: 8000,
    });
    const plan = planOpeningStockImport(csv('sku,quantity,unit\nSKU-011,500,g'), reference({ productsBySku: new Map([['sku-011', tomatoes]]) }));
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ unit: 'kg', quantity: 0.5, enteredUnit: 'g', enteredQuantity: 500, valueMinor: 4000 });
  });

  it('reports a unit problem on its own row and still plans the rest of the file', () => {
    const soda = product({ id: '88888888-8888-4888-8888-888888888808', sku: 'SKU-008', name: 'Soda 300ml', conversions: new Map([['crate', 24]]) });
    const plan = asCrates(['sku,quantity,unit', 'SKU-003,10,crate', 'SKU-008,3,crate'], new Map([['sku-003', sugar], ['sku-008', soda]]));
    expect(plan.errors).toMatchObject([{ code: 'UNKNOWN_CONVERSION', sku: 'SKU-003' }]);
    expect(plan.rows.map((row) => row.sku)).toEqual(['SKU-008']);
  });

  it('plans a JSON record with a unit through exactly the same vocabulary as a CSV column', () => {
    const fromRecords = planOpeningStockImport(recordsToCsvRows([{ sku: 'SKU-003', quantity: 10, unit: 'crate', unit_cost: 240 }]), reference({ productsBySku: new Map([['sku-003', crates]]) }));
    const fromCsv = asCrates(['sku,quantity,unit,unit_cost', 'SKU-003,10,crate,240']);
    expect(fromRecords.rows).toEqual(fromCsv.rows);
    expect(fromRecords.rows[0]).toMatchObject({ quantity: 240, unitCostMinor: 1000 });
  });

  it('holds a counted quantity typed in the BASE unit to the rule its own commit will apply', () => {
    // The server converts a quantity written in the product's unit as well (`0.5 ea` is refused as
    // firmly as `0.5 crate`), so a preview that waved it through would be overruled by its commit.
    const plan = planOpeningStockImport(csv('sku,quantity\nSKU-003,0.5'), reference());
    expect(plan.errors).toEqual([expect.objectContaining({ field: 'quantity', code: 'FRACTIONAL_QUANTITY', sku: 'SKU-003' })]);
    expect(plan.rows).toHaveLength(0);
    expect(plan.totalQuantity).toBe(0);
  });

  it('invents no rule for a unit the shop has never typed (item 4.6)', () => {
    const untyped = product({ id: '88888888-8888-4888-8888-888888888809', sku: 'SKU-003', unit: 'btl', unitKind: null });
    const typed = reference({ productsBySku: new Map([['sku-003', untyped]]) });

    // No kind means no rule — a half bottle is accepted, because refusing it would be inventing
    // `count` for a unit nobody described.
    expect(planOpeningStockImport(csv('sku,quantity\nSKU-003,0.5'), typed).errors).toEqual([]);

    // A pack cannot be converted either: with no kind there is nothing to convert WITH.
    const packed = product({ id: '88888888-8888-4888-8888-888888888809', sku: 'SKU-003', unit: 'btl', unitKind: null, conversions: new Map([['crate', 12]]) });
    const plan = planOpeningStockImport(csv('sku,quantity,unit\nSKU-003,10,crate'), reference({ productsBySku: new Map([['sku-003', packed]]) }));
    expect(plan.errors).toEqual([expect.objectContaining({ field: 'unit', code: 'UNKNOWN_UNIT', sku: 'SKU-003' })]);
  });
});
