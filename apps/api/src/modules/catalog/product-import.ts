/**
 * Product import planning — a PURE function over parsed rows and a snapshot of reference data.
 *
 * The whole file is decided before a single row is written, which is what makes the promise in the
 * plan ("a malformed file creates no partial records and reports every bad row") structural rather
 * than a matter of remembering to roll back. Preview and commit run this same function, so what the
 * operator is shown is exactly what a commit will do — there is no second code path that could
 * disagree with the preview.
 *
 * Nothing here touches the database, so it is directly unit-testable.
 */
import { parseMinorInput } from '../../domain/pricing';
import { CsvRow, canonicalColumn as canonicalHeader, recordsToCsvRows as recordsToRows } from '../../domain/csv';

/** Canonical column -> the header spellings we accept. A typo must fail loudly, not import zeros. */
const COLUMN_ALIASES: Record<string, string[]> = {
  sku: ['sku', 'code', 'item_code', 'item'],
  name: ['name', 'product_name', 'title'],
  description: ['description', 'notes'],
  category: ['category', 'category_name', 'department'],
  brand: ['brand', 'brand_name', 'manufacturer'],
  tax: ['tax', 'tax_rate', 'vat'],
  unit: ['unit', 'uom', 'unit_of_measure'],
  price: ['price', 'selling_price', 'retail_price', 'unit_price'],
  cost: ['cost', 'cost_price', 'buying_price', 'purchase_price'],
  barcodes: ['barcodes', 'barcode', 'ean', 'upc'],
  stock_tracked: ['stock_tracked', 'track_stock', 'tracks_stock', 'tracked'],
  reorder_point: ['reorder_point', 'reorder', 'reorder_at', 'low_stock'],
  active: ['active', 'is_active', 'enabled'],
};

const canonicalColumn = (header: string): string | null => canonicalHeader(header, COLUMN_ALIASES);

const REQUIRED_COLUMNS = ['sku', 'name', 'price'];

/** One file is one transaction; keep it to a size a superette can actually review. */
export const MAX_IMPORT_ROWS = 5000;
const MAX_BARCODES_PER_PRODUCT = 20;

export interface ImportRowError {
  /** 1-based physical line in the file, matching what the operator sees in their spreadsheet. */
  line: number;
  sku: string | null;
  field: string | null;
  code: string;
  message: string;
}

export interface PlannedProductRow {
  line: number;
  action: 'create' | 'update';
  /** Set for an update; a create gets its id from the service. */
  productId: string | null;
  sku: string;
  name: string;
  description: string | null;
  categoryName: string | null;
  /** Kept as written (like `categoryName`) so the service can resolve it after creating missing ones. */
  brandName: string | null;
  taxCategoryId: string | null;
  unit: string;
  isStockTracked: boolean;
  isActive: boolean;
  priceMinor: number;
  costMinor: number;
  /**
   * Low-stock threshold in base units (item 4.9): a number, or null for a blank cell in a column
   * that IS present (clearing one on purpose). Undefined means the file has no `reorder_point`
   * column at all — an update then leaves the stored threshold alone, the same carve-out the
   * barcode column gets, because a plain re-import must not wipe thresholds set by hand.
   */
  reorderPoint?: number | null;
  /**
   * The full desired barcode set, or null when the file has no barcode column at all — an update then
   * leaves the stored set alone instead of wiping it because someone omitted a column.
   */
  barcodes: string[] | null;
}

export interface ProductImportPlan {
  rows: PlannedProductRow[];
  errors: ImportRowError[];
  /** Category names the file referenced that do not exist yet, in first-seen order. */
  categoriesToCreate: string[];
  /** Brand names the file referenced that do not exist yet, in first-seen order. */
  brandsToCreate: string[];
  createCount: number;
  updateCount: number;
}

export interface ImportReferenceData {
  /** SKU (lower-cased) -> existing product id. */
  productIdBySku: Map<string, string>;
  /** SKUs that exist more than once ignoring case, which makes them unsafe to update. */
  ambiguousSkus: Set<string>;
  /** barcode -> owning product id. */
  barcodeOwner: Map<string, string>;
  /** tax category name (lower-cased) -> the category, so an error can quote the operator's spelling. */
  taxCategoriesByName: Map<string, { id: string; name: string }>;
  /** category name (lower-cased) -> the category. */
  categoriesByName: Map<string, { id: string; name: string }>;
  /** brand name (lower-cased) -> the brand. */
  brandsByName: Map<string, { id: string; name: string }>;
}

export interface ImportOptions {
  /**
   * Only categories and brands: a tax rate is money, and a typo must never conjure a new VAT rate.
   * Brands are cheap labels, but they still exist only when the operator asked for them to be
   * created — an unknown word is a typo until someone says otherwise.
   */
  createMissingCategories: boolean;
  createMissingBrands: boolean;
}

/**
 * JSON imports use the same column vocabulary as CSV, so one planner and one error report serve both
 * formats. Values may be strings, numbers, booleans or arrays (barcodes, joined with `|`).
 *
 * `price` is a currency amount in both formats. A `priceMinor` key is NOT a column we accept — it is
 * reported as an unknown column rather than being silently read as 6500 shillings.
 */
export function recordsToCsvRows(records: unknown[]): CsvRow[] {
  return recordsToRows(records, COLUMN_ALIASES);
}

/** true / false / yes / no / 1 / 0 — anything else is rejected rather than guessed at. */
function parseBoolean(text: string): boolean | null {
  const value = text.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(value)) return true;
  if (['false', 'no', 'n', '0'].includes(value)) return false;
  return null;
}

export function planProductImport(
  rows: CsvRow[],
  reference: ImportReferenceData,
  options: ImportOptions,
): ProductImportPlan {
  const errors: ImportRowError[] = [];
  const planned: PlannedProductRow[] = [];
  const categoriesToCreate: string[] = [];
  const brandsToCreate: string[] = [];
  const pendingCategoryKeys = new Set<string>();
  const pendingBrandKeys = new Set<string>();

  if (rows.length === 0) {
    return { rows: [], errors: [{ line: 1, sku: null, field: null, code: 'EMPTY_FILE', message: 'The file has no rows' }], categoriesToCreate, brandsToCreate, createCount: 0, updateCount: 0 };
  }
  if (rows.length - 1 > MAX_IMPORT_ROWS) {
    return {
      rows: [],
      errors: [{ line: 1, sku: null, field: null, code: 'TOO_MANY_ROWS', message: `A file may contain at most ${MAX_IMPORT_ROWS} products` }],
      categoriesToCreate,
      brandsToCreate,
      createCount: 0,
      updateCount: 0,
    };
  }

  // --- header ------------------------------------------------------------------------------------
  const header = rows[0];
  const index = new Map<string, number>();
  header.cells.forEach((cell, position) => {
    const canonical = canonicalColumn(cell);
    if (canonical === null) {
      // An unrecognised column is almost always a typo, and ignoring it would import a price of zero.
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
  if (errors.length > 0) {
    return { rows: [], errors, categoriesToCreate, brandsToCreate, createCount: 0, updateCount: 0 };
  }
  if (rows.length === 1) {
    errors.push({ line: header.line, sku: null, field: null, code: 'EMPTY_FILE', message: 'The file has a header but no product rows' });
    return { rows: [], errors, categoriesToCreate, brandsToCreate, createCount: 0, updateCount: 0 };
  }

  const hasBarcodeColumn = index.has('barcodes');
  const valueAt = (row: CsvRow, column: string): string | null => {
    const position = index.get(column);
    if (position === undefined) return null;
    const cell = row.cells[position];
    return (cell ?? '').trim();
  };

  // --- rows --------------------------------------------------------------------------------------
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();

  for (const row of rows.slice(1)) {
    const rowErrors: ImportRowError[] = [];
    const rawSku = valueAt(row, 'sku') ?? '';
    const sku = rawSku;
    const skuKey = sku.toLowerCase();
    const fail = (field: string | null, code: string, message: string) => {
      rowErrors.push({ line: row.line, sku: sku.length > 0 ? sku : null, field, code, message });
    };

    // A row wider than the header means an unescaped comma shifted every column — importing it would
    // write someone else's values into this product's fields.
    if (row.cells.length > header.cells.length) {
      fail(null, 'RAGGED_ROW', `Row has ${row.cells.length} values but the header has ${header.cells.length} columns`);
    }

    if (sku.length === 0) fail('sku', 'MISSING_SKU', 'Every row needs an SKU');
    else if (sku.length > 64) fail('sku', 'INVALID_SKU', 'An SKU may be at most 64 characters');

    const name = valueAt(row, 'name') ?? '';
    if (name.length === 0) fail('name', 'MISSING_NAME', 'Every row needs a name');
    else if (name.length > 200) fail('name', 'INVALID_NAME', 'A name may be at most 200 characters');

    const description = valueAt(row, 'description') ?? '';
    if (description.length > 2000) fail('description', 'INVALID_DESCRIPTION', 'A description may be at most 2000 characters');

    const priceText = valueAt(row, 'price') ?? '';
    let priceMinor = 0;
    if (priceText.length === 0) {
      fail('price', 'MISSING_PRICE', 'Every row needs a price');
    } else {
      const parsed = parseMinorInput(priceText);
      if (parsed === null) fail('price', 'INVALID_PRICE', `"${priceText}" is not an amount (e.g. 65 or 65.50)`);
      else priceMinor = parsed;
    }

    const costText = valueAt(row, 'cost') ?? '';
    let costMinor = 0;
    if (costText.length > 0) {
      const parsed = parseMinorInput(costText);
      if (parsed === null) fail('cost', 'INVALID_COST', `"${costText}" is not an amount (e.g. 45 or 45.50)`);
      else costMinor = parsed;
    }

    const unitText = valueAt(row, 'unit') ?? '';
    const unit = unitText.length === 0 ? 'ea' : unitText;
    if (unit.length > 16) fail('unit', 'INVALID_UNIT', 'A unit may be at most 16 characters');

    let isStockTracked = true;
    const stockText = valueAt(row, 'stock_tracked') ?? '';
    if (stockText.length > 0) {
      const parsed = parseBoolean(stockText);
      if (parsed === null) fail('stock_tracked', 'INVALID_BOOLEAN', `"${stockText}" is not yes/no`);
      else isStockTracked = parsed;
    }

    let isActive = true;
    const activeText = valueAt(row, 'active') ?? '';
    if (activeText.length > 0) {
      const parsed = parseBoolean(activeText);
      if (parsed === null) fail('active', 'INVALID_BOOLEAN', `"${activeText}" is not yes/no`);
      else isActive = parsed;
    }

    // Threshold (item 4.9): valueAt tells "no column" (null) from "blank cell" (''), and the two
    // mean different things — absent must not wipe what somebody set by hand, blank clears.
    let reorderPoint: number | null | undefined = undefined;
    const reorderText = valueAt(row, 'reorder_point');
    if (reorderText !== null) {
      if (reorderText.length === 0) reorderPoint = null;
      else {
        const parsed = Number(reorderText);
        // Six decimals is the column's own precision: beyond it the database would round silently,
        // and this file should say so out loud instead of quietly moving someone's number.
        const decimals = reorderText.includes('.') ? reorderText.split('.')[1].length : 0;
        if (!Number.isFinite(parsed) || parsed < 0 || decimals > 6) {
          fail('reorder_point', 'INVALID_NUMBER', `"${reorderText}" is not a quantity at or above zero (at most 6 decimals)`);
        } else reorderPoint = parsed;
      }
    }

    // Tax must already exist: silently inventing a VAT rate from a typo is a money error.
    let taxCategoryId: string | null = null;
    const taxText = valueAt(row, 'tax') ?? '';
    if (taxText.length > 0) {
      const found = reference.taxCategoriesByName.get(taxText.toLowerCase());
      if (!found) {
        const known = [...reference.taxCategoriesByName.values()].map((tax) => tax.name).slice(0, 10).join(', ');
        fail('tax', 'UNKNOWN_TAX', known.length > 0 ? `Unknown tax rate "${taxText}"; known: ${known}` : `Unknown tax rate "${taxText}"; no tax rates are defined yet`);
      } else {
        taxCategoryId = found.id;
      }
    }

    let categoryName: string | null = null;
    const categoryText = valueAt(row, 'category') ?? '';
    if (categoryText.length > 0) {
      categoryName = categoryText;
      const existing = reference.categoriesByName.get(categoryText.toLowerCase());
      if (!existing) {
        if (!options.createMissingCategories) {
          fail('category', 'UNKNOWN_CATEGORY', `Unknown category "${categoryText}"`);
        } else {
          const key = categoryText.toLowerCase();
          if (!pendingCategoryKeys.has(key)) {
            pendingCategoryKeys.add(key);
            categoriesToCreate.push(categoryText);
          }
        }
      }
    }

    // Brands follow the same rule as categories: they exist when they are already known, or when
    // the operator asked for missing ones to be created. An unknown brand is a typo until then.
    let brandName: string | null = null;
    const brandText = valueAt(row, 'brand') ?? '';
    if (brandText.length > 0) {
      brandName = brandText;
      const existing = reference.brandsByName.get(brandText.toLowerCase());
      if (!existing) {
        if (!options.createMissingBrands) {
          fail('brand', 'UNKNOWN_BRAND', `Unknown brand "${brandText}"`);
        } else {
          const key = brandText.toLowerCase();
          if (!pendingBrandKeys.has(key)) {
            pendingBrandKeys.add(key);
            brandsToCreate.push(brandText);
          }
        }
      }
    }

    let barcodes: string[] | null = null;
    if (hasBarcodeColumn) {
      const barcodeText = valueAt(row, 'barcodes') ?? '';
      const codes: string[] = [];
      for (const raw of barcodeText.split(/[|;\s]+/)) {
        const code = raw.trim();
        if (code.length === 0 || codes.includes(code)) continue;
        if (code.length > 64) {
          fail('barcodes', 'INVALID_BARCODE', `Barcode "${code}" is longer than 64 characters`);
          continue;
        }
        codes.push(code);
      }
      if (codes.length > MAX_BARCODES_PER_PRODUCT) {
        fail('barcodes', 'TOO_MANY_BARCODES', `At most ${MAX_BARCODES_PER_PRODUCT} barcodes per product`);
      }
      barcodes = codes;
    }

    // Cross-row checks only make sense once the row is otherwise usable.
    let existingId: string | null = null;
    if (rowErrors.length === 0) {
      if (seenSku.has(skuKey)) {
        fail('sku', 'DUPLICATE_SKU_IN_FILE', `SKU ${sku} also appears on line ${seenSku.get(skuKey)}`);
      } else {
        seenSku.set(skuKey, row.line);
      }

      if (reference.ambiguousSkus.has(skuKey)) {
        fail('sku', 'AMBIGUOUS_SKU', `More than one product already uses SKU ${sku}`);
      }

      existingId = reference.productIdBySku.get(skuKey) ?? null;

      for (const code of barcodes ?? []) {
        const earlier = seenBarcode.get(code);
        if (earlier !== undefined) {
          fail('barcodes', 'DUPLICATE_BARCODE_IN_FILE', `Barcode ${code} also appears on line ${earlier}`);
          continue;
        }
        seenBarcode.set(code, row.line);
        const owner = reference.barcodeOwner.get(code);
        if (owner && owner !== existingId) {
          fail('barcodes', 'DUPLICATE_BARCODE', `Barcode ${code} already belongs to another product`);
        }
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    planned.push({
      line: row.line,
      action: existingId ? 'update' : 'create',
      productId: existingId,
      sku,
      name,
      description: description.length === 0 ? null : description,
      categoryName,
      brandName,
      taxCategoryId,
      unit,
      isStockTracked,
      isActive,
      priceMinor,
      costMinor,
      reorderPoint,
      barcodes,
    });
  }

  return {
    rows: planned,
    errors,
    categoriesToCreate,
    brandsToCreate,
    createCount: planned.filter((row) => row.action === 'create').length,
    updateCount: planned.filter((row) => row.action === 'update').length,
  };
}
