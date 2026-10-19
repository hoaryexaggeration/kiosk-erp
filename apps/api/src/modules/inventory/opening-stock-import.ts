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
import { CsvRow, canonicalColumn as canonicalHeader, recordsToCsvRows as recordsToRows } from '../../domain/csv';

/** Canonical column -> the header spellings we accept. A typo must fail loudly, not import zeros. */
const COLUMN_ALIASES: Record<string, string[]> = {
  sku: ['sku', 'code', 'item_code', 'item'],
  quantity: ['quantity', 'qty', 'on_hand', 'opening_qty', 'opening_quantity', 'count'],
  unit_cost: ['unit_cost', 'cost', 'cost_price', 'buying_price', 'purchase_price', 'opening_cost'],
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
  unit: string;
  quantity: number;
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
  unit: string;
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

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }
    // Unreachable: an unknown SKU was already reported above.
    if (product === null) continue;

    if (!costWasGiven) unitCostMinor = product.costMinor;
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
          `importing adds ${formatQuantity(quantity)} more (${formatQuantity(onHandBefore)} → ${formatQuantity(onHandBefore + quantity)}).`,
      });
    }

    planned.push({
      line: row.line,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      quantity,
      unitCostMinor,
      costWasGiven,
      onHandBefore,
      onHandAfter: onHandBefore + quantity,
      valueMinor: roundHalfUp(quantity * unitCostMinor),
    });
  }

  return planOf();
}
