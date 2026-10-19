# Opening-stock import format (item 4.5)

`POST /v1/inventory/opening-stock/import` (permission `inventory.receive`) takes the stock a shop
starts with — the shelf count on day one, or a second branch's opening position — and turns it into
**movements**.

It is the counterpart of `catalogue-import-format.md`: that file creates the products, this one gives
them a quantity. Both formats use the **same column vocabulary** and the same two rules.

## The rule that defines this endpoint

**An opening balance is an event, never an edit.** Each row becomes an `inventory_movements` row with
`reason = 'opening'` and `source_type = 'opening_stock'` — a dated, attributed fact — and the
`stock_balances` quantity is *derived* from those movements. There is no code path in this import
that writes a quantity directly, which is what makes an opening balance auditable and what lets the
FIFO layers value everything that later sells (ADR 0009).

Two consequences worth stating plainly:

- **The import does not create products.** A SKU the catalogue does not know is an error, not a new
  item. Load the catalogue first.
- **Preview creates nothing, not even a stock location.** On a branch that has never held stock the
  preview reports `onHandBefore: 0` because there is genuinely nothing recorded, and the location is
  created only when the commit runs.

## The two rules that matter

1. **Nothing is written unless the whole file is valid.** A file with any bad row reports every bad
   row and stores nothing.
2. **Preview and commit run the same planner.** What a preview shows is exactly what a commit does.

Request body:

| Field | Meaning |
| --- | --- |
| `branchId` | The branch this opening position belongs to. Must belong to the same tenant, else `404 UNKNOWN_BRANCH`. |
| `requestId` | A UUID generated **once per file chosen**. It becomes the import's identity — see *Retries* below. |
| `csv` | The file contents as a string. Provide this **or** `records`. |
| `records` | A JSON array of objects. Provide this **or** `csv`. |
| `commit` | `false` (default) is a pure preview: validate and report, write nothing. |

## Columns

Unrecognised columns are **rejected**, not ignored. Required columns are marked ✅.

| Column (aliases) | Meaning |
| --- | --- |
| ✅ `sku` (`code`, `item_code`, `item`) | The product code, matched **ignoring case**. The product must already exist and must be stock-tracked. |
| ✅ `quantity` (`qty`, `on_hand`, `opening_qty`, `opening_quantity`, `count`) | The opening quantity. Must be **more than zero**. Whole numbers or decimals (weighed goods: `12.5` kg). |
| `unit_cost` (`cost`, `cost_price`, `buying_price`, `purchase_price`, `opening_cost`) | What this stock cost, as a **currency amount**: `95` means KES 95.00. Omitted → the product's recorded cost. |

A product that is *inactive* is fine — you may still be opening stock for a discontinued line. A
product that is **not stock-tracked** (airtime, a service) is an error: it has no quantity to record.

### Quantities and costs are parsed exactly

Money follows §7: `95` becomes 9500 minor units, `95.999` is **rejected** rather than rounded,
because quietly rounding someone's cost is a money error. Quantities accept decimals because goods
are weighed, but `-4`, `abc` and `1 2` are all errors — nothing is guessed at.

### Costs and valuation

Each committed line opens a FIFO valuation layer at its unit cost (ADR 0009), so the shop's stock
value is on the books from the first day rather than being invented at the first sale.

- Cost **given in the file** → the layer opens at that cost, **and** `products.cost_minor` is updated
  to match (it is only ever the latest known purchase cost; valuation itself stays layer-based).
- Cost **omitted** → the layer opens at the product's recorded cost.
- Cost omitted **and** the product has none → the line still imports, with an
  `OPENING_COST_UNKNOWN` warning, so stock is never *silently* valued at zero.

## Warnings

Warnings inform; they never block. They are shown before the commit is offered, and the commit button
says how many there are.

| Code | Scope | Meaning |
| --- | --- | --- |
| `OPENING_ALREADY_PRESENT` | row | This product already has opening stock at this branch. The import **adds** to it rather than replacing it, and the message spells out `24 → 34`. |
| `OPENING_COST_UNKNOWN` | row | No cost was given and none is recorded, so this line will be valued at 0. |
| `BRANCH_ALREADY_TRADING` | file | The branch already has sales, receipts or adjustments. Opening stock normally comes first; importing now puts stock in front of history that already happened. |

## Response

```jsonc
{
  "status": "invalid" | "validated" | "committed",
  "alreadyApplied": false,
  "rowCount": 120,
  "validCount": 118,
  "errorCount": 2,
  "warningCount": 1,
  "totalQuantity": 1840.5,
  "totalValueMinor": 24189000,
  "errors": [
    { "line": 37, "sku": "SKU-118", "field": "quantity", "code": "QUANTITY_NOT_POSITIVE",
      "message": "Opening quantity must be more than zero" }
  ],
  "warnings": [
    { "line": 4, "sku": "SKU-003", "field": "quantity", "code": "OPENING_ALREADY_PRESENT",
      "message": "Opening stock is already recorded for SKU-003 (40 on hand); importing adds 10 more (40 → 50)." }
  ],
  "preview": [
    { "line": 2, "sku": "SKU-003", "name": "Sugar 1kg", "unit": "ea", "quantity": 40,
      "onHandBefore": 0, "onHandAfter": 40, "unitCostMinor": 14500,
      "valueMinor": 580000, "costWasGiven": false }
  ],
  "previewTruncated": false
}
```

`onHandBefore` → `onHandAfter` is the whole point of the preview: it is the only quantity the
operator is asked to approve, and it is shown next to the quantity that will be *appended* to get
there. `line` is the line the operator sees in their spreadsheet.

A file with problems answers **with the report**, not an error status: a preview that found problems
is a successful preview. `invalid` means "nothing was written".

Error codes: `EMPTY_FILE`, `TOO_MANY_ROWS`, `MISSING_COLUMN`, `UNKNOWN_COLUMN`, `DUPLICATE_COLUMN`,
`RAGGED_ROW`, `MISSING_SKU`, `INVALID_SKU`, `MISSING_QUANTITY`, `INVALID_QUANTITY`,
`QUANTITY_NOT_POSITIVE`, `INVALID_UNIT_COST`, `DUPLICATE_SKU_IN_FILE`, `AMBIGUOUS_SKU`,
`UNKNOWN_SKU`, `PRODUCT_NOT_STOCK_TRACKED`.

Out of the report's scope: `403 FORBIDDEN` without `inventory.receive`, `404 UNKNOWN_BRANCH` for a
branch of another tenant.

## Retries

A commit that times out and is retried with the same `requestId` is recognised instead of opening the
stock twice: the first commit writes `requestId` as every movement's `source_id` and `command_id`, and
the second request finds those rows first. It answers `status: "committed"` with
`alreadyApplied: true`, and the app says *already imported* rather than *imported*.

The ledger's own unique index on `(tenant_id, command_id, product_id, source_id)` is the backstop: if
two identical commits ever raced, one would fail rather than both applying.

## In the app

Stock → **Opening stock** → choose a CSV/JSON file (or type the lines — `SKU-003,40`, header
supplied automatically) → the server's report appears → **Import N line(s)**. On success the balances
are refetched, so the Stock list shows the new on-hand immediately.

## Example

```csv
sku,quantity,unit_cost
SKU-003,40
SKU-004,24,265
SKU-011,15.5
```

```bash
# Preview (writes nothing)
curl -s -X POST http://localhost:3000/v1/inventory/opening-stock/import \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -Rs '{branchId: $BRANCH, requestId: $ID, csv: ., commit: false}' < opening.csv)"

# Commit — same requestId as the preview
curl -s -X POST http://localhost:3000/v1/inventory/opening-stock/import \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -Rs '{branchId: $BRANCH, requestId: $ID, csv: ., commit: true}' < opening.csv)"
```
