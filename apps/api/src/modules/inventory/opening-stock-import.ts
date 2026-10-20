/**
 * Opening-stock import planning — a PURE function over parsed rows and a snapshot of stock state.
 *
 * Item 4.5's exit criterion is "opening balances arrive as stock movements, never as a direct
 * quantity edit", and this file is where that is decided: the planner has no notion of writing a
 * balance, only of movements that will be appended. Everything is decided before a single row is
 * written, so a malformed file creates no partial positions and reports every bad row, and preview
 * and commit run this same function — what the operator approves is exactly what a commit does.
 *
 * Nothing here touches the database, so it is directly unit-testable.
 */
import { parseMinorInput, roundHalfUp } from '../../domain/pricing';
import { convertQuantity, UnitKind } from '../../domain/units';
import { CsvRow, canonicalColumn as canonicalHeader, recordsToCsvRows as recordsToRows } from '../../domain/csv';

/** Canonical column -> the header spellings we accept. A typo must fail loudly, not import zeros. */
const COLUMN_ALIASES: Record<string, string[]> = {
  sku: ['sku', 'code', 'item_code', 'item'],
  quantity: ['quantity', 'qty', 'on_hand', 'opening_qty', 'opening_quantity', 'count'],
  unit_cost: ['unit_cost', 'cost', 'cost_price', 'buying_price', 'purchase_price', 'opening_cost'],
  // Optional (item 4.6): the unit each quantity is written in. Omit it and everything is the
  // product's base unit, exactly as before.
  unit: ['unit', 'uom', 'unit_of_measure'],
};

const canonicalColumn = (header: string): string | null => canonicalHeader(header, COLUMN_ALIASES);
const REQUIRED_COLUMNS = ['sku', 'quantity'];

/** One import is one transaction; keep it to a count an operator can actually review. */
export const MAX_OPENING_ROWS = 5000;

/** One problem or one advisory, pointing at the line the operator sees in their file. */
export interface OpeningStockIssue {
  line: number;
  sku: string | null;
  field: string | null;
  code: string;
  message: string;
}

export interface PlannedOpeningRow {
  line: number;
  productId: string;
  sku: string;
  name: string;
  /** The unit the quantity will be RECORDED in: always the product's base unit (item 4.6). */
  unit: string;
  /** The quantity in `unit`. The file's own number when no conversion applied, the converted one when it did. */
  quantity: number;
  /** What the file said, when it named a different unit — null for a row written in the base unit. */
  enteredUnit: string | null;
  enteredQuantity: number | null;
  /** Fully resolved: an explicit file cost, or the product's recorded cost when the file omitted it. */
  unitCostMinor: number;
  /** true only when the FILE said the cost — that is what makes `products.cost_minor` worth updating. */
  costWasGiven: boolean;
  onHandBefore: number;
  onHandAfter: number;
  valueMinor: number;
}

export interface OpeningStockPlan {
  rows: PlannedOpeningRow[];
  errors: OpeningStockIssue[];
  /** Advisory only: a warning never blocks an import, but it must be seen before one is approved. */
  warnings: OpeningStockIssue[];
  totalQuantity: number;
  totalValueMinor: number;
}

export interface OpeningStockProduct {
  id: string;
  sku: string;
  name: string;
  /** The base unit: the only unit this opening stock may be recorded in (item 4.6). */
  unit: string;
  /**
   * Kind of that base unit, which decides whether a quantity in it must stay whole — **null when
   * the unit is not in the shop's unit catalogue**. Null is not the same as `count`: it means the
   * ledger has no rule for this product, and the rule the ledger has must not be invented here, or
   * a preview would accept what a commit then refuses (item 4.6).
   */
  unitKind: UnitKind | null;
  /** Pack sizes this product may be written in, keyed by lower-cased unit: 'crate' -> 24. */
  conversions: Map<string, number>;
  costMinor: number;
  isStockTracked: boolean;
}

export interface OpeningStockReference {
  /** SKU (lower-cased) -> a live product. Deleted products are absent, so they read as unknown. */
  productsBySku: Map<string, OpeningStockProduct>;
  /** SKUs that exist more than once ignoring case, which makes them unsafe to count against. */
  ambiguousSkus: Set<string>;
  /** product id -> on-hand at this branch's location. Absent means "nothing recorded", not zero. */
  onHandByProduct: Map<string, number>;
  /** Product ids that already carry an opening-stock movement at this branch. */
  productsWithOpening: Set<string>;
  /** The branch has movements that are not opening stock — sales, receipts or adjustments. */
  branchAlreadyTrading: boolean;
}

export function recordsToCsvRows(records: unknown[]): CsvRow[] {
  return recordsToRows(records, COLUMN_ALIASES);
}

/** Whole numbers and decimals both count (weighed goods); anything else is not a quantity. */
function parseQuantity(text: string): number | null {
  const value = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity : null;
}

/** 12, 12.5, 0.75 — never 12.500000000000001 in a message an operator has to read. */
const formatQuantity = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));

export function planOpeningStockImport(rows: CsvRow[], reference: OpeningStockReference): OpeningStockPlan {
  const errors: OpeningStockIssue[] = [];
  const warnings: OpeningStockIssue[] = [];
  const planned: PlannedOpeningRow[] = [];

  const planOf = (): OpeningStockPlan => ({
    rows: planned,
    errors,
    warnings,
    totalQuantity: planned.reduce((sum, row) => sum + row.quantity, 0),
    totalValueMinor: planned.reduce((sum, row) => sum + row.valueMinor, 0),
  });

  // A branch that has already traded is a fact about the branch, not about the file, so it is
  // reported whether or not the file itself turns out to be usable.
  if (reference.branchAlreadyTrading) {
    warnings.push({
      line: 1,
      sku: null,
      field: null,
      code: 'BRANCH_ALREADY_TRADING',
      message:
        'This branch already has sales, receipts or adjustments recorded. Opening stock normally comes first: importing now adds stock in front of history that has already happened.',
    });
  }

  if (rows.length === 0) {
    errors.push({ line: 1, sku: null, field: null, code: 'EMPTY_FILE', message: 'The file has no rows' });
    return planOf();
  }
  if (rows.length - 1 > MAX_OPENING_ROWS) {
    errors.push({ line: 1, sku: null, field: null, code: 'TOO_MANY_ROWS', message: `A file may contain at most ${MAX_OPENING_ROWS} lines` });
    return planOf();
  }

  // --- header ------------------------------------------------------------------------------------
  const header = rows[0];
  const index = new Map<string, number>();
  header.cells.forEach((cell, position) => {
    const canonical = canonicalColumn(cell);
    if (canonical === null) {
      // An unrecognised column is almost always a typo, and ignoring it would import a zero.
      if (cell.trim().length > 0) {
        errors.push({ line: header.line, sku: null, field: cell.trim(), code: 'UNKNOWN_COLUMN', message: `Unknown column "${cell.trim()}"` });
      }
      return;
    }
    if (index.has(canonical)) {
      errors.push({ line: header.line, sku: null, field: canonical, code: 'DUPLICATE_COLUMN', message: `Column "${canonical}" appears more than once` });
      return;
    }
    index.set(canonical, position);
  });
  for (const column of REQUIRED_COLUMNS) {
    if (!index.has(column)) {
      errors.push({ line: header.line, sku: null, field: column, code: 'MISSING_COLUMN', message: `The file must have a "${column}" column` });
    }
  }
  if (errors.length > 0) return planOf();
  if (rows.length === 1) {
    errors.push({ line: header.line, sku: null, field: null, code: 'EMPTY_FILE', message: 'The file has a header but no rows' });
    return planOf();
  }

  const valueAt = (row: CsvRow, column: string): string | null => {
    const position = index.get(column);
    if (position === undefined) return null;
    return (row.cells[position] ?? '').trim();
  };

  // --- rows --------------------------------------------------------------------------------------
  const seenSku = new Map<string, number>();

  for (const row of rows.slice(1)) {
    const rowErrors: OpeningStockIssue[] = [];
    const sku = valueAt(row, 'sku') ?? '';
    const skuKey = sku.toLowerCase();
    const fail = (field: string | null, code: string, message: string) => {
      rowErrors.push({ line: row.line, sku: sku.length > 0 ? sku : null, field, code, message });
    };

    // A row wider than the header means an unescaped comma shifted every column — importing it would
    // record someone else's count against this product.
    if (row.cells.length > header.cells.length) {
      fail(null, 'RAGGED_ROW', `Row has ${row.cells.length} values but the header has ${header.cells.length} columns`);
    }

    if (sku.length === 0) fail('sku', 'MISSING_SKU', 'Every row needs an SKU');
    else if (sku.length > 64) fail('sku', 'INVALID_SKU', 'An SKU may be at most 64 characters');

    const quantityText = valueAt(row, 'quantity') ?? '';
    let quantity = 0;
    if (quantityText.length === 0) {
      fail('quantity', 'MISSING_QUANTITY', 'Every row needs an opening quantity');
    } else {
      const parsed = parseQuantity(quantityText);
      if (parsed === null) fail('quantity', 'INVALID_QUANTITY', `"${quantityText}" is not a quantity (e.g. 12 or 12.5)`);
      else if (parsed <= 0) fail('quantity', 'QUANTITY_NOT_POSITIVE', 'Opening quantity must be more than zero');
      else quantity = parsed;
    }

    const costText = valueAt(row, 'unit_cost') ?? '';
    let unitCostMinor = 0;
    let costWasGiven = false;
    if (costText.length > 0) {
      const parsed = parseMinorInput(costText);
      if (parsed === null) fail('unit_cost', 'INVALID_UNIT_COST', `"${costText}" is not an amount (e.g. 45 or 45.50)`);
      else {
        unitCostMinor = parsed;
        costWasGiven = true;
      }
    }

    // Cross-row checks only make sense once the row is otherwise usable.
    if (rowErrors.length === 0) {
      if (seenSku.has(skuKey)) {
        fail('sku', 'DUPLICATE_SKU_IN_FILE', `SKU ${sku} also appears on line ${seenSku.get(skuKey)}`);
      } else {
        seenSku.set(skuKey, row.line);
      }
      if (reference.ambiguousSkus.has(skuKey)) {
        fail('sku', 'AMBIGUOUS_SKU', `More than one product already uses SKU ${sku}`);
      }
    }

    let product: OpeningStockProduct | null = null;
    if (rowErrors.length === 0) {
      product = reference.productsBySku.get(skuKey) ?? null;
      if (product === null) {
        fail('sku', 'UNKNOWN_SKU', `No product with SKU ${sku} — add it to the catalogue first`);
      } else if (!product.isStockTracked) {
        fail('sku', 'PRODUCT_NOT_STOCK_TRACKED', `${product.name} is not stock-tracked, so it has no opening quantity to record`);
      }
    }

    // --- the unit column (item 4.6) ------------------------------------------------------------
    // A file may say `crate,10` for a product held in `ea`. The conversion happens HERE, in the
    // planner, so preview shows exactly what a commit will record — and it refuses rather than
    // rounds: 1.3 crates of 24 is 31.2 bottles, which is not something a shop can receive.
    let enteredUnit: string | null = null;
    let enteredQuantity: number | null = null;
    let conversionFactor = 1;
    let baseQuantity = quantity;
    if (rowErrors.length === 0 && product !== null) {
      const unitText = valueAt(row, 'unit') ?? '';
      if (unitText.length > 0 && unitText.toLowerCase() !== product.unit.toLowerCase()) {
        // Checked in the same order the ledger checks them, so a preview refuses for exactly the
        // reasons its own commit would (item 4.6).
        if (product.unitKind === null) {
          fail(
            'unit',
            'UNKNOWN_UNIT',
            `${product.sku} is stocked in "${product.unit}", which is not in this shop's unit catalogue — add it under Units first`,
          );
        } else {
          const factor = product.conversions.get(unitText.toLowerCase());
          if (factor === undefined) {
            fail(
              'unit',
              'UNKNOWN_CONVERSION',
              `${product.sku} has no pack size: 1 ${unitText} is not defined as ${product.unit}. Add the conversion under the product first`,
            );
          } else {
            const outcome = convertQuantity({ quantity, fromFactor: factor, toFactor: 1, kind: product.unitKind });
            if (!outcome.ok) {
              fail(
                'unit',
                outcome.code,
                outcome.code === 'FRACTIONAL_QUANTITY'
                  ? `${formatQuantity(quantity)} ${unitText} is not a whole number of ${product.unit}, which is counted rather than weighed`
                  : `Cannot express ${formatQuantity(quantity)} ${unitText} in ${product.unit}`,
              );
            } else {
              baseQuantity = outcome.quantity;
              conversionFactor = factor;
              enteredUnit = unitText;
              enteredQuantity = quantity;
            }
          }
        }
      } else if (product.unitKind !== null) {
        // A quantity written in the BASE unit is held to the base unit's rule too — the server
        // applies exactly this conversion to it, so `0.5 ea` is refused here as firmly as it is
        // refused on arrival. When the unit has no kind there is no rule, and none is invented.
        const identity = convertQuantity({ quantity, fromFactor: 1, toFactor: 1, kind: product.unitKind });
        if (!identity.ok) {
          fail(
            'quantity',
            identity.code,
            identity.code === 'FRACTIONAL_QUANTITY'
              ? `${product.unit} is counted, so a quantity in it must be a whole number — ${formatQuantity(quantity)} is not`
              : `Cannot accept ${formatQuantity(quantity)} ${product.unit}`,
          );
        } else {
          baseQuantity = identity.quantity;
        }
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }
    // Unreachable: an unknown SKU was already reported above.
    if (product === null) continue;

    if (!costWasGiven) unitCostMinor = product.costMinor;
    // A stated cost is per the unit on the paperwork — 24,000 a crate becomes 1,000 a bottle by the
    // same factor as the quantity. The product's OWN recorded cost is already per base unit and is
    // therefore left alone; only a cost the file actually quoted travels down the factor.
    if (costWasGiven && enteredUnit !== null) unitCostMinor = roundHalfUp(unitCostMinor / conversionFactor);
    if (unitCostMinor <= 0) {
      warnings.push({
        line: row.line,
        sku: product.sku,
        field: 'unit_cost',
        code: 'OPENING_COST_UNKNOWN',
        message: `No unit cost was given for ${product.sku} and none is recorded for the product, so this opening stock will be valued at 0.`,
      });
    }

    const onHandBefore = reference.onHandByProduct.get(product.id) ?? 0;
    if (reference.productsWithOpening.has(product.id)) {
      warnings.push({
        line: row.line,
        sku: product.sku,
        field: 'quantity',
        code: 'OPENING_ALREADY_PRESENT',
        message:
          `Opening stock is already recorded for ${product.sku} (${formatQuantity(onHandBefore)} on hand); ` +
          `importing adds ${formatQuantity(baseQuantity)} ${product.unit} more (${formatQuantity(onHandBefore)} → ${formatQuantity(onHandBefore + baseQuantity)}).`,
      });
    }

    planned.push({
      line: row.line,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      quantity: baseQuantity,
      enteredUnit,
      enteredQuantity,
      unitCostMinor,
      costWasGiven,
      onHandBefore,
      onHandAfter: onHandBefore + baseQuantity,
      valueMinor: roundHalfUp(baseQuantity * unitCostMinor),
    });
  }

  return planOf();
}
