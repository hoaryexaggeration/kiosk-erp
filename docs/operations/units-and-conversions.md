# Units of measure, pack sizes and brands (item 4.6)

A superette buys in crates and sells in pieces; a butchery weighs in kilos and prices in grams. The
architecture's answer (§3.C) is not two stock books — it is **one**:

> Stock is held in exactly one unit per product. Every other unit a quantity may be *written* in is
> a conversion **into** that unit.

That single sentence is the whole item. `1 crate = 24 bottles` is a fact about soda (and 12 for
water), so a pack size belongs to a product, not to a unit. What the ledger records is always
bottles, and the crate it arrived as is remembered beside the number rather than becoming the number.

Three tables carry it, all per tenant (§9):

| Table | Row is | Uniqueness |
| --- | --- | --- |
| `units_of_measure` | a word a quantity may be written in (`ea`, `crate`, `kg`) and its `kind` | `(tenant, lower(code))` |
| `unit_conversions` | one pack size **of one product**: `1 <unit> = <factor> <product.unit>` | `(tenant, product, lower(unit))` |
| `brands` | who makes a product | `(tenant, lower(name))` |

`products` gains `brand_id`. No new server events: units, brands and pack sizes are configuration,
and devices read them with the product payload and the config snapshot.

## Units: `code`, `name`, `kind`

`kind` is `count`, `weight` or `volume`, and it is not decoration — it is the rule the ledger applies
to a quantity in that unit:

- **`count`** — a converted quantity must be a **whole number**. `1.3` crates of 24 is `31.2`
  bottles; there is no such thing as 31.2 of a thing a shop receives, so it is refused, never rounded.
- **`weight` / `volume`** — fractional, because a scale does not care.

A unit is created with `POST /v1/units` (`catalog.manage`); reading `GET /v1/units` needs no
permission. Codes are stored lower-cased (`EA` → `ea`) and are at most 16 characters.

`products.unit` stays a free-text column, but it is **validated at write time** rather than by a
foreign key: a product may only be given pack sizes if its own selling unit is in the catalogue, and
a product whose unit nobody typed simply has no rule (see *The base-unit rule* below). This is
deliberate — a FK would let an existing product point at a unit that has since been retired, and the
refusal belongs in the sentence the operator reads, not in an integrity error they cannot act on.

## Pack sizes: factors are always relative to the base

`unit_conversions` stores `{product, unit, factor}` where `factor` is **how many base units one of
that unit contains**: 1 crate of 24 bottles → `factor = 24`. Storing factors against the product's
unit rather than against a universal unit table is what makes "a crate is 24 of these and 12 of
those" expressible at all.

Validation on write (`POST`/`PATCH /v1/products`, `conversions`):

| Rule | Code |
| --- | --- |
| The product's selling unit must be in the unit catalogue | `UNKNOWN_UNIT` |
| The pack's unit must be in the unit catalogue | `UNKNOWN_UNIT` |
| A pack may not convert the unit into itself (`crate` → `crate`) | `SELF_CONVERSION` |
| `factor` must be finite and greater than zero | `INVALID_FACTOR` |
| Changing a product's selling unit must not strand packs already stored | `UNKNOWN_UNIT` / `SELF_CONVERSION` |

`conversions` is a **SET**, exactly like `barcodes` (item 4.1): a value that is present replaces the
product's whole set — omitting a pack retires it everywhere after sync — and a value that is absent
on an update leaves the stored set alone. The device caches them the same way (`product_conversions`
in Room), because a pack retired on the server must stop converting on a till that has not synced.

## Brands

`POST /v1/brands` (`catalog.manage`), read with `GET /v1/brands`. Names are unique ignoring case
("Coca" and "COCA" are one brand to a shopkeeper), and a product points at one with `brandId`.

A brand id is checked for tenancy before a product may reference it (§9): a UUID that belongs to
another shop answers `404 UNKNOWN_BRAND` rather than quietly attaching foreign reference data.

Bulk import follows the same rule as categories: an unknown brand is an error (`UNKNOWN_BRAND`)
unless the request sets `createMissingBrands: true`, in which case the file's own spelling creates
them and the report lists them under `brandsToCreate`. As with categories, **a file with no `brand`
column clears the brand on update** — the file is the desired state of the columns it carries.

## The conversion contract

`convertQuantity({ quantity, fromFactor, toFactor, kind })` is implemented identically in three
languages and checked against one vector file (`fixtures/unit-conversion.json`, 74 checks):

| | |
| --- | --- |
| TypeScript | `apps/api/src/domain/units.ts` |
| Kotlin | `apps/android/core/common/.../Units.kt` |
| Swift | `apps/ios/KioskERP/Core/Domain/Units.swift` |
| Reference | `packages/domain-fixtures/src/index.mjs` |

- Result is **fixed-point at 3 decimals, rounded half-up** (`numeric(18,3)` is the ledger's
  precision). Money itself is never involved: it stays integer minor units (§7).
- A `count` result that is not whole fails with `FRACTIONAL_QUANTITY`.
- Non-finite quantities → `INVALID_QUANTITY`; factors that are not positive and finite →
  `INVALID_CONVERSION_FACTOR`.
- The contract returns `{ ok: false, code }` — **no message**. Messages are written by whoever
  displays them, in the language of the screen or the operator, so the same code reads correctly in
  an API error, an import report and an Android dialog.

## Where conversion happens

**`InventoryService.resolveQuantity` is the only place the ledger converts.** It runs for every
movement — receipts, adjustments, the opening-stock import — and returns one of three outcomes:
`ok` (with the base quantity and whether a conversion happened), `missing`, or `invalid` with a code.
`applyMovement` is the single write path behind it, so there is no code path that can record stock in
a unit other than `products.unit`.

What each caller then does:

- **`applyMovement`** stores `quantity_delta` and `unit` **as base**, and writes `entered_unit` /
  `entered_quantity` **only when a conversion actually happened** (a movement written in the base
  unit carries no phantom pair; a CHECK enforces the two columns being null together). The history
  screen reads that pair to show `10 crate → +240 ea`.
- **`receiveStock`** resolves every line *before* writing anything, so a receipt naming one unknown
  pack is refused whole (`UNKNOWN_CONVERSION`) with nothing received. A quoted `unitCostMinor` is per
  the unit on the paperwork and is divided by the factor (`roundHalfUp(cost / factor)`) to become
  cost per base unit; `products.cost_minor` and the FIFO layers are **already** per base unit and are
  never divided.
- **`adjustStock`** pre-passes the same way, then compares a supervisor override against the
  **base** quantity (`-4 crate` is 48 bottles, and 48 is what must not go below zero).
- **Opening-stock import** converts in the pure planner, so preview and commit show identical
  numbers, and the commit re-resolves once to record the pack.

### The base-unit rule

A quantity typed in the product's own unit is held to the same rule — `0.5 ea` is refused as firmly
as `0.5 crate` would be, because the server applies `convertQuantity(q, 1, 1, kind)` on that path
too. The import planner does the same, so a preview never accepts what its own commit then refuses.

**When the unit's kind is unknown there is no rule, and none is invented.** Falling back to `count`
would be harmless-looking and wrong: it would stop a legal weigh for a product whose unit nobody had
added to the vocabulary, with a message telling the operator their kilos were not whole numbers. So
`unit_kind` / `kind` is reported as `null`, conversion of a pack is refused (`UNKNOWN_UNIT`, matching
the ledger's own wording), and a plain base-unit quantity passes unchanged.

## Surface

Endpoints (all tenant-scoped, `catalog.manage` for writes):

| | |
| --- | --- |
| `GET /v1/units` · `POST /v1/units` | the unit vocabulary (`code`, `name`, `kind`) |
| `GET /v1/brands` · `POST /v1/brands` | brands (`id`, `name`) |
| `GET /v1/config/snapshot` | gains `units` and `brands` alongside categories and tax rates |

Product payloads (`GET /v1/products`, `GET /v1/products/:id`, create/update responses, the
`product.created` / `product.updated` server events and the import preview rows) gain:

```jsonc
{
  "brand_id": "…",          // null when the product has no brand
  "brand_name": "…",        // denormalised so a list can show it without a join
  "unit_kind": "count",     // kind of `unit`, or null when the unit is not in the catalogue
  "conversions": [ { "unit": "crate", "factor": 24 } ]   // the full SET
}
```

`unit_kind` rides with the conversions on purpose: a device that has just pulled a product must be
able to convert while the shop is offline, and the rule it needs belongs to the product it is
applying it to (§6).

Error codes from this item: `UNKNOWN_UNIT`, `UNKNOWN_CONVERSION`, `SELF_CONVERSION`,
`INVALID_FACTOR`, `FRACTIONAL_QUANTITY`, `INVALID_QUANTITY`, `INVALID_CONVERSION_FACTOR`,
`UNKNOWN_UNIT_KIND`, `INVALID_UNIT`, `DUPLICATE_UNIT` (409), `INVALID_BRAND`, `DUPLICATE_BRAND`
(409), `UNKNOWN_BRAND` (404). Validation that fails Zod's shape check answers `422 VALIDATION_ERROR`
with `fieldErrors`.

## In the app

- **Catalogue → product editor**: the selling unit is picked from the shop's vocabulary; **Pack
  sizes** lists `1 crate = 24 ea` with an add/remove row; **Category, brand & tax** picks a brand.
  Saving sends the whole set, so a pack removed here is retired everywhere after sync.
- **Catalogue → Manage**: units (code, name, kind) and brands can be added; a kind is chosen from
  `count`/`weight`/`volume`, never typed.
- **Stock → Adjust**: the product's base unit and its pack sizes are offered as choices read from
  Room (so the dialog works offline), the preview shows `10 crate = 240 ea` computed with the same
  `Units.convertQuantity` the server posts with, and an impossible conversion blocks the button with
  the reason rather than queueing a command the server will reject.
- **Stock → movement history**: a converted movement reads `10 crate → +240 ea`, both numbers kept.
- **Stock → Opening stock**: the optional `unit` column says how the goods were counted
  (`SKU-008,10,crate`); the preview reports `enteredUnit`/`enteredQuantity` next to the base quantity
  that will be recorded. See `opening-stock-import.md`.
- **Catalogue import**: the optional `brand` column with `createMissingBrands`. See
  `catalogue-import-format.md`.

## Example

```bash
# A unit, a brand, and the pack sizes that make them useful
curl -s -X POST http://localhost:3000/v1/units -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"code":"crate","name":"Crate","kind":"count"}'
curl -s -X POST http://localhost:3000/v1/brands -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Savannah Foods"}'

curl -s -X PATCH http://localhost:3000/v1/products/$PRODUCT -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"unit":"ea","conversions":[{"unit":"crate","factor":24}],"brandId":"…"}'

# A receipt of 10 crates arrives as 240 bottles, and remembers the crate
curl -s -X POST http://localhost:3000/v1/sync/push -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"commands":[{
    "commandId":"…","branchId":"…","deviceId":"…","aggregateType":"StockReceipt",
    "aggregateId":"…","schemaVersion":1,
    "payload":{"receipt":{"id":"…","reason":"grn","lines":[
      {"productId":"…","quantity":10,"unit":"crate","unitCostMinor":24000}]}}}]}'
```

## Verification

- `fixtures/unit-conversion.json` — 74 checks across TS/Kotlin/Swift ports (`npm run fixtures:check`).
- `apps/api/tests/unit/unit-conversion.spec.ts` — the contract's rounding and refusal rules.
- `apps/api/tests/integration/units-conversions.spec.ts` — unit/brand CRUD and tenancy, the SET
  rule, refusals, and the ledger claims: a receipt in crates lands in one base-unit valuation layer
  at a per-base cost, a whole receipt is refused rather than partially applied, and the supervisor
  override is measured in base units.
- `apps/api/tests/unit/opening-stock-import.spec.ts` — the `unit` column and the base-unit rule.
