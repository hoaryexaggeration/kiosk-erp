# Low-stock thresholds (item 4.9)

Phase 4 closes its inventory loop with one question an owner asks every week: *when do I buy more
of this?* §15 Phase 4 names "low-stock thresholds and stock movement history"; the history shipped
in 4.10's screen (4.7/4.8 surface), the thresholds here. D8 in the deferred-items ledger.

## The one number

`products.reorder_point` (migration `0007`) — nullable, at or above zero, in the product's **base**
units (`ea`, `kg`, … — the same units the Stock screen counts in, never a pack size).

- **It lives on the product, not on the branch.** The catalogue is shared across branches (owner
  decision §18): a reorder point is a fact about the good. Per-shelf levels would be a per-branch
  attribute like pricing (item 4.11) and are deliberately not this.
- **`NULL` means "no alert configured."** Every line opts IN to being watched, so a shop is never
  drowning in a dashboard of zero-stock service items. The demo seed watches five products: three
  breach on a fresh seed (SKU-005 rice 18/20, SKU-013 eggs 10/12, SKU-018 shampoo 8/10) and two sit
  healthy (SKU-004 oil 24/12, SKU-015 soap 40/15).
- **Fractions are allowed** (2.5 kg of tomatoes is a real reorder point); files reject anything
  negative or beyond six decimals loudly rather than rounding — the same loud-failure rule prices
  get in `catalogue-import-format.md`.

## The breach is computed on the device

`balance <= threshold` is evaluated **on the phone, from Room** — the cached product carries the
threshold and the cached branch balance carries the number, both synced like everything else. That
is the whole point: the shelf speaks while the radio is off, and the same computation is what a
dashboard will later run on the server for reporting.

The Stock screen says it two ways, both per the explicit-state rule (§6 — no green ticks by
silence):

- **A banner** above the rows: *"3 products at or below the reorder point • Pishori rice 2kg 18 ea
  (point 20) • …"*.
- **A state pill on each row**: `LOW (≤ n unit)` in amber when `0 < balance <= threshold`,
  `OUT OF STOCK` in red when the balance is zero and the line is watched.

A `null` balance is "not cached", never zero — it never claims a breach. An unwatched product gets
no pill: silence is stated by absence, never by a green tick.

## Setting a threshold

1. **Per product** — the catalogue editor, *Stock & status* section (stock-tracked products only):
   *Reorder point (`<unit>`)*, blank = no alert. Junk text disables Save instead of failing later.
   Activate/deactivate carries the threshold along, because that draft replaces the stored product.
2. **In bulk** — the catalogue import's optional `reorder_point` column (`reorder`, `reorder_at`,
   `low_stock`). It gets the barcode carve-out: a file that never carried the column leaves stored
   thresholds alone, while a **blank cell in a present column** clears one on purpose.
3. **API** — `reorderPoint` on `POST /v1/products` and `PATCH /v1/products/:id`: explicit `null`
   clears, absent keeps (same rule as brand/category). It rides `productPayload`, so it is in the
   product list, the save responses and every `product.created` / `product.updated` event — a
   device that is already synced picks the change up from the delta alone.

## Deliberately not here (later phases)

- **Push notifications** for a fresh breach — "tell me the moment it happens" — belong to the
  notifications phase; today the alert is what you see when you open Stock.
- **Min/max levels and replenishment suggestions** ("buy 3 crates, this supplier, this lead time")
  are Phase 7 purchasing territory, where supplier and order data exist; they will aggregate this
  same flag rather than invent a second one.
- **Dashboards** (§3.D) report the same computed breach per branch; the flag stays single-source.

## Tests

`catalog-pricing.spec.ts` (create/list, absent-keeps, null-clears, negative refused with
`422 VALIDATION_ERROR`) and `catalog-import.spec.ts` (column sets, omitted column survives,
blank cell clears, invalid value fails the row) — part of the 163/163 across 14 suites, plus
74/74 domain fixtures, run against Docker Postgres.
