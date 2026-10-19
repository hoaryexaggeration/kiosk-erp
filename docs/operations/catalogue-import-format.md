# Catalogue import format (item 4.4)

`POST /v1/products/import` (permission `catalog.manage`) loads a product master from a CSV file or a
JSON array of records. It is the fast way to load a shop's catalogue; the app's product editor is the
slow way, one item at a time.

Both formats use the **same column vocabulary**, so one error report explains both.

## The two rules that matter

1. **Nothing is written unless the whole file is valid.** A file with any bad row is reported and
   stores nothing. A half-imported catalogue is worse than a rejected file, because nobody can then
   tell which half is real.
2. **Preview and commit run the same planner.** What a preview shows is exactly what a commit does.

Request body:

| Field | Meaning |
| --- | --- |
| `csv` | The file contents as a string. Provide this **or** `records`. |
| `records` | A JSON array of objects. Provide this **or** `csv`. |
| `commit` | `false` (default) is a pure preview: validate and report, write nothing. |
| `createMissingCategories` | `true` lets the file create categories it references. Never applies to tax rates. |

## Columns

Unrecognised columns are **rejected**, not ignored: a typo like `prise` would otherwise import a price
of zero. Required columns are marked ✅.

| Column (aliases) | Meaning |
| --- | --- |
| ✅ `sku` (`code`, `item_code`, `item`) | The product code. Matched **ignoring case**; an existing SKU is updated, a new one is created. |
| ✅ `name` (`product_name`, `title`) | Product name. |
| ✅ `price` (`selling_price`, `retail_price`, `unit_price`) | Selling price as a **currency amount**: `65` means KES 65.00, `65.50` means KES 65.50. |
| `cost` (`cost_price`, `buying_price`, `purchase_price`) | Latest known purchase cost. Defaults to `0`. |
| `description` (`notes`) | Free text. |
| `category` (`category_name`, `department`) | Resolved by name against existing categories. |
| `tax` (`tax_rate`, `vat`) | The **name of an existing tax category**, e.g. `VAT 16% (inclusive)`. |
| `unit` (`uom`, `unit_of_measure`) | Defaults to `ea`. |
| `barcodes` (`barcode`, `ean`, `upc`) | One or more codes, separated by `\|`, `;` or a space. **Replaces** the product's barcode set. |
| `stock_tracked` (`track_stock`, `tracked`) | `yes`/`no`, `true`/`false`, `1`/`0`. Defaults to `yes`. |
| `active` (`is_active`, `enabled`) | Same vocabulary. Defaults to `yes`. |

### Prices are parsed exactly

Prices never pass through binary floating point. `1.15` becomes 115 minor units, not 114 (which is
what `parseFloat("1.15") * 100` gives). More than two decimals is **rejected** rather than quietly
rounded — quietly rounding someone's typed price is a money error.

### Tax must already exist

A tax rate is money. If a file references a tax category that does not exist, that row is an error
listing the rates that do exist, rather than a new VAT rate being invented from a typo. Set the rates
up first (app → Catalogue → Categories & tax, or `POST /v1/tax-categories`).

Categories are different: they are labels, so `createMissingCategories: true` may create them.

### Barcodes

The `barcodes` column is the **full desired set** for that product (item 4.1 semantics). Re-importing
a product with one barcode removed stops that barcode resolving at the till.

If the file has **no `barcodes` column at all**, the stored set is left untouched — omitting a column
must not wipe data. A `barcodes` column with an empty value does clear the set.

A barcode that already belongs to a *different* product is an error, never a silent reassignment.

## Response

```jsonc
{
  "status": "invalid" | "validated" | "committed",
  "rowCount": 120,          // product rows in the file
  "validCount": 118,
  "errorCount": 2,
  "createCount": 40,
  "updateCount": 78,
  "categoriesToCreate": ["Snacks"],
  "errors": [
    { "line": 37, "sku": "SKU-118", "field": "price", "code": "INVALID_PRICE",
      "message": "\"6.5.0\" is not an amount (e.g. 65 or 65.50)" }
  ],
  "preview": [ /* first 100 planned rows */ ],
  "previewTruncated": false
}
```

`line` is the line number in the file as the operator sees it in a spreadsheet, so an error report can
be read side by side with the file.

A file with errors answers **with the report**, not an error status: a preview that found problems is a
successful preview. `invalid` means "nothing was written".

Error codes: `EMPTY_FILE`, `MISSING_COLUMN`, `UNKNOWN_COLUMN`, `DUPLICATE_COLUMN`, `TOO_MANY_ROWS`,
`RAGGED_ROW`, `MISSING_SKU`, `INVALID_SKU`, `MISSING_NAME`, `INVALID_NAME`, `INVALID_DESCRIPTION`,
`MISSING_PRICE`, `INVALID_PRICE`, `INVALID_COST`, `INVALID_UNIT`, `INVALID_BOOLEAN`, `UNKNOWN_TAX`,
`UNKNOWN_CATEGORY`, `INVALID_BARCODE`, `TOO_MANY_BARCODES`, `DUPLICATE_SKU_IN_FILE`,
`DUPLICATE_BARCODE_IN_FILE`, `DUPLICATE_BARCODE`, `AMBIGUOUS_SKU`.

## Example

```csv
sku,name,price,category,tax,unit,cost,barcodes
SKU-100,Bread 400g,65,Bakery,VAT 16% (inclusive),ea,45,6001000000011
SKU-101,Milk 500ml,58,Dairy,VAT 16% (inclusive),ea,40,6001000000028|6001000000035
```

```bash
# Preview (writes nothing)
curl -s -X POST http://localhost:3000/v1/products/import \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -Rs '{csv: ., commit: false}' < catalogue.csv)"

# Commit
curl -s -X POST http://localhost:3000/v1/products/import \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -Rs '{csv: ., commit: true, createMissingCategories: true}' < catalogue.csv)"
```
