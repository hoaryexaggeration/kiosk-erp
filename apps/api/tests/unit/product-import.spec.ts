import { parseCsv } from '../../src/domain/csv';
import { ImportReferenceData, planProductImport } from '../../src/modules/catalog/product-import';

/**
 * The import path decides prices and barcodes in bulk, so it is tested as a pure function: no
 * database, no HTTP. Every rejection is a case an operator must be told about rather than a case the
 * server quietly resolves on their behalf.
 */
const rows = (lines: string[][]) => lines.map((cells, position) => ({ line: position + 1, cells }));

const reference = (overrides: Partial<ImportReferenceData> = {}): ImportReferenceData => ({
  productIdBySku: new Map(),
  ambiguousSkus: new Set(),
  barcodeOwner: new Map(),
  taxCategoriesByName: new Map([['vat 16% (inclusive)', { id: 'tax-1', name: 'VAT 16% (inclusive)' }]]),
  categoriesByName: new Map([['drinks', { id: 'cat-1', name: 'Drinks' }]]),
  brandsByName: new Map([['kaskazi drinks', { id: 'brand-1', name: 'Kaskazi Drinks' }]]),
  ...overrides,
});

const HEADER = ['sku', 'name', 'price'];
const FULL_HEADER = ['sku', 'name', 'price', 'category', 'tax', 'unit', 'cost', 'barcodes'];

describe('CSV reader', () => {
  it('reads plain rows and reports the physical line each started on', () => {
    expect(parseCsv('sku,name\nA,Apple\nB,Bread\n')).toEqual([
      { line: 1, cells: ['sku', 'name'] },
      { line: 2, cells: ['A', 'Apple'] },
      { line: 3, cells: ['B', 'Bread'] },
    ]);
  });

  it('keeps a comma inside a quoted cell and unescapes doubled quotes', () => {
    expect(parseCsv('a,b\n"1,234","say ""hi"""')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1,234', 'say "hi"'] },
    ]);
  });

  it('handles CRLF, a missing final newline, a BOM and blank padding lines', () => {
    // The BOM is stripped but does not create a line; the blank line IS a physical line, so the last
    // row is line 4 even though it is the second row the caller will act on.
    expect(parseCsv('\uFEFFsku,name\r\nA,Apple\r\n\r\nB,Bread')).toEqual([
      { line: 1, cells: ['sku', 'name'] },
      { line: 2, cells: ['A', 'Apple'] },
      { line: 4, cells: ['B', 'Bread'] },
    ]);
  });

  it('keeps a newline inside a quoted cell while still counting lines', () => {
    expect(parseCsv('a\n"line one\nline two"\nz')).toEqual([
      { line: 1, cells: ['a'] },
      { line: 2, cells: ['line one\nline two'] },
      { line: 4, cells: ['z'] },
    ]);
  });
});

describe('product import planning', () => {
  it('accepts a valid file and plans one create per row', () => {
    const plan = planProductImport(
      rows([FULL_HEADER, ['SKU-100', 'Bread 400g', '65', 'drinks', 'VAT 16% (inclusive)', 'ea', '45', '6001000000011|6001000000028']]),
      reference(),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.createCount).toBe(1);
    expect(plan.rows[0]).toMatchObject({
      line: 2,
      action: 'create',
      sku: 'SKU-100',
      name: 'Bread 400g',
      priceMinor: 6500,
      costMinor: 4500,
      taxCategoryId: 'tax-1',
      barcodes: ['6001000000011', '6001000000028'],
    });
  });

  it('proves the money parser is in the import path: 1.15 must not lose a cent', () => {
    const plan = planProductImport(rows([HEADER, ['S', 'N', '1.15']]), reference(), { createMissingCategories: false, createMissingBrands: false });
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0].priceMinor).toBe(115);
  });

  it('rejects an unknown column instead of importing a price of zero', () => {
    const plan = planProductImport(rows([['sku', 'name', 'prise'], ['S', 'N', '65']]), reference(), { createMissingCategories: false, createMissingBrands: false });
    expect(plan.rows).toEqual([]);
    expect(plan.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['UNKNOWN_COLUMN', 'MISSING_COLUMN']));
  });

  it('reports every bad row, not just the first, and plans only the good ones', () => {
    const plan = planProductImport(
      rows([
        HEADER,
        ['SKU-1', 'Good', '10'],
        ['SKU-2', '', '10'],
        ['SKU-3', 'Bad price', '6.5.0'],
        ['SKU-4', 'No price', ''],
      ]),
      reference(),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.errors.map((e) => [e.line, e.code])).toEqual([
      [3, 'MISSING_NAME'],
      [4, 'INVALID_PRICE'],
      [5, 'MISSING_PRICE'],
    ]);
    expect(plan.rows.map((row) => row.sku)).toEqual(['SKU-1']);
  });

  it('never invents a tax rate from a typo, and says what is available', () => {
    const plan = planProductImport(
      rows([['sku', 'name', 'price', 'category', 'tax'], ['S', 'N', '10', '', 'VAT 8%']]),
      reference(),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.rows).toEqual([]);
    expect(plan.errors[0].code).toBe('UNKNOWN_TAX');
    expect(plan.errors[0].message).toContain('VAT 16% (inclusive)');
  });

  it('only creates a missing category when asked, and never creates a tax rate', () => {
    const categoryHeader = ['sku', 'name', 'price', 'category'];
    const strict = planProductImport(rows([categoryHeader, ['S', 'N', '10', 'New Aisle']]), reference(), { createMissingCategories: false, createMissingBrands: false });
    expect(strict.errors[0].code).toBe('UNKNOWN_CATEGORY');
    expect(strict.categoriesToCreate).toEqual([]);

    const lenient = planProductImport(
      rows([categoryHeader, ['S', 'N', '10', 'New Aisle'], ['T', 'N', '10', 'New Aisle']]),
      reference(),
      { createMissingCategories: true, createMissingBrands: false },
    );
    expect(lenient.errors).toEqual([]);
    expect(lenient.categoriesToCreate).toEqual(['New Aisle']);
  });

  it('carries a known brand through to the planned row, by the name the file wrote', () => {
    const plan = planProductImport(
      rows([['sku', 'name', 'price', 'brand'], ['SKU-1', 'Soda 300ml', '8', 'Kaskazi Drinks'], ['SKU-2', 'Bread', '65', '']]),
      reference(),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.rows.map((row) => row.brandName)).toEqual(['Kaskazi Drinks', null]);
    expect(plan.brandsToCreate).toEqual([]);
  });

  it('creates a missing brand only when asked — a label is not a licence to invent one', () => {
    const header = ['sku', 'name', 'price', 'brand'];
    const strict = planProductImport(rows([header, ['S', 'N', '10', 'New Drinks']]), reference(), {
      createMissingCategories: false,
      createMissingBrands: false,
    });
    expect(strict.errors[0]).toMatchObject({ code: 'UNKNOWN_BRAND', field: 'brand' });
    expect(strict.brandsToCreate).toEqual([]);

    const lenient = planProductImport(
      rows([header, ['S', 'N', '10', 'New Drinks'], ['T', 'N', '10', 'New Drinks']]),
      reference(),
      { createMissingCategories: false, createMissingBrands: true },
    );
    expect(lenient.errors).toEqual([]);
    expect(lenient.brandsToCreate).toEqual(['New Drinks']);
  });

  it('catches a repeated SKU inside the file and points at the earlier line', () => {
    const plan = planProductImport(rows([HEADER, ['SKU-1', 'A', '10'], ['sku-1', 'B', '20']]), reference(), { createMissingCategories: false, createMissingBrands: false });
    expect(plan.rows).toHaveLength(1);
    expect(plan.errors[0]).toMatchObject({ line: 3, code: 'DUPLICATE_SKU_IN_FILE' });
    expect(plan.errors[0].message).toContain('line 2');
  });

  it('catches a barcode reused inside the file and one owned by another product', () => {
    const plan = planProductImport(
      rows([
        FULL_HEADER,
        ['A', 'A', '10', '', '', '', '', '111'],
        ['B', 'B', '10', '', '', '', '', '111'],
        ['C', 'C', '10', '', '', '', '', '999'],
      ]),
      reference({ barcodeOwner: new Map([['999', 'other-product']]) }),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.errors.map((e) => e.code)).toEqual(['DUPLICATE_BARCODE_IN_FILE', 'DUPLICATE_BARCODE']);
  });

  it('allows a product to keep its own barcode on a re-import', () => {
    const plan = planProductImport(
      rows([FULL_HEADER, ['SKU-1', 'A', '10', '', '', '', '', '111']]),
      reference({ productIdBySku: new Map([['sku-1', 'prod-1']]), barcodeOwner: new Map([['111', 'prod-1']]) }),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ action: 'update', productId: 'prod-1' });
  });

  it('leaves the stored barcode set alone when the file has no barcode column', () => {
    const plan = planProductImport(
      rows([HEADER, ['SKU-1', 'A', '10']]),
      reference({ productIdBySku: new Map([['sku-1', 'prod-1']]) }),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.rows[0].barcodes).toBeNull();
  });

  it('refuses to update an SKU that is ambiguous ignoring case', () => {
    const plan = planProductImport(
      rows([HEADER, ['SKU-1', 'A', '10']]),
      reference({ ambiguousSkus: new Set(['sku-1']) }),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(plan.rows).toEqual([]);
    expect(plan.errors[0].code).toBe('AMBIGUOUS_SKU');
  });

  it('rejects a row wider than the header rather than shifting its values', () => {
    const plan = planProductImport(rows([HEADER, ['SKU-1', 'A', '10', 'extra']]), reference(), { createMissingCategories: false, createMissingBrands: false });
    expect(plan.rows).toEqual([]);
    expect(plan.errors[0].code).toBe('RAGGED_ROW');
  });

  it('reports an empty file and a header-only file', () => {
    expect(planProductImport([], reference(), { createMissingCategories: false, createMissingBrands: false }).errors[0].code).toBe('EMPTY_FILE');
    expect(planProductImport(rows([HEADER]), reference(), { createMissingCategories: false, createMissingBrands: false }).errors[0].code).toBe('EMPTY_FILE');
  });

  it('accepts yes/no for booleans and rejects anything else', () => {
    const ok = planProductImport(
      rows([['sku', 'name', 'price', 'stock_tracked', 'active'], ['S', 'N', '10', 'no', 'yes']]),
      reference(),
      { createMissingCategories: false, createMissingBrands: false },
    );
    expect(ok.errors).toEqual([]);
    expect(ok.rows[0]).toMatchObject({ isStockTracked: false, isActive: true });

    const bad = planProductImport(rows([['sku', 'name', 'price', 'active'], ['S', 'N', '10', 'maybe']]), reference(), {
      createMissingCategories: false,
      createMissingBrands: false,
    });
    expect(bad.errors[0].code).toBe('INVALID_BOOLEAN');
  });
});
