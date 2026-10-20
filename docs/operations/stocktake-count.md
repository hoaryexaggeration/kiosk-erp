# Stocktakes and cycle counts (item 4.8)

Any movement list the architecture asks for includes "cycle counts and full stocktakes" (§3.D), and
Phase 4's work list ends with "audit every adjustment" (§15). The rule that gives a count its shape
is:

> **A count produces adjustment movements with reason and actor — stock quantities cannot be
> changed without a movement source.**

So a stocktake is not an editor for `stock_balances`. The operator reads the shelf, the device sends
the numbers it READ, and the server derives one variance per line against the book it holds:

```
count  ->  the shelf holds N (as typed, in the unit it was counted in)
server ->  variance = N − book   |   variance = 0: write NOTHING at all
                            |   variance ≠ 0: one adjustment movement, reason `stocktake`
```

Two properties make this a count rather than a clever edit:

1. **The payload carries counted quantities, never deltas.** "The shelf holds 20" is a fact about the
   shelf; only the server's book may be subtracted from it. A device whose cached balance has drifted
   would otherwise post `book + (stale book − counted)` and land at a number nobody read.
2. **Agreement writes nothing.** A line that matches the book leaves no movement — the ledger stays a
   list of things that happened, not of every number somebody called out.

And one property separates it from an adjustment: **a count cannot push stock below zero**
(`quantity >= 0` by schema — you cannot count −2 bottles), so unlike an adjustment it never needs a
supervisor override. The refusals below are about a count that was never a number.

## Payload

Outbox command, `aggregateType: "Stocktake"`:

```jsonc
{
  "stocktake": {
    "id": "<device-chosen uuid>",
    "note": "Sunday night count",              // optional — audit + server event, not each movement
    "lines": [
      { "productId": "…", "quantity": 20 },                 // counted in the product's own unit
      { "productId": "…", "quantity": 2, "unit": "crate" }  // counted in a pack (item 4.6)
    ]
  }
}
```

`quantity` is **how many units are on the shelf**, `>= 0`. A line the operator left blank is a line
nobody counted and is simply absent: unlike a transfer receipt, a cycle count is partial by design
and only asserts what was physically seen. `quantity: 0` is a real count — *none here*.

## What the server does, in order

1. Resolves **every** line first (product and pack conversion through `resolveQuantity`, the item 4.6
   choke point): an unparseable line refuses the whole count (`FRACTIONAL_QUANTITY` — `20.5 ea` is
   not a thing a shelf holds), because a half-applied count leaves the shelf between two readings.
   Lines naming a product this tenant does not have are dropped — a stale device cache must not
   block a real count — and if that empties the count → `EMPTY_STOCKTAKE`.
2. Reads the branch's book per line, computes `variance = counted − book`, and clamps float dust
   (`2.3000000000000003` against `2.3` **agrees** — a dust movement would cost the ledger its
   readability).
3. `variance == 0` → report it as *matched* and write nothing.
4. `variance != 0` → one movement through `applyMovement` with `reason: 'stocktake'`,
   `source_type: 'stocktake'`, `source_id` = the count's id, and the caller's `actor_id` — the audit
   the architecture asks for. The variance is written **in the unit the shelf was counted in** when it
   divides exactly into packs (`counted 2 crate` against a book of 48 bottles lands as `+2 crate`), and
   in the base unit when it does not (a pack counted against a book that is not a whole number of
   packs has no whole-pack truth, and inventing one would put a fraction in a counted unit).
5. Cost: a **short** variance consumes the FIFO layers and books `cogs_minor` — shrinkage is a loss in
   shillings too, not only units. A **found** variance opens a layer at `products.cost_minor`, the last
   known cost — the rule a receipt follows — rather than at zero: a shelf that turns up with goods is
   still a shelf holding value (ADR 0009).
6. Writes the audit row (`stock.counted`, with the note and the tallies), a `stock.counted` server
   event and outbox event, and returns the report.

Result on accept:

```jsonc
{
  "stocktakeId": "…", "serverSeq": 123,
  "countedLines": 12, "matchedLines": 9, "varianceLines": 3, "convertedLines": 1,
  "lostValueMinor": 96000, "foundValueMinor": 0, "uncosted": false,
  "lines": [ { "productId": "…", "sku": "SKU-008", "name": "…", "counted": 20, "unit": "ea",
               "bookBefore": 24, "variance": -4 } ]   // first 100 lines
}
```

| Outcome | Condition |
| --- | --- |
| `accepted` | every variance was costed |
| `review_required` + conflict `UNCOSTED_STOCK` | the book had no valuation layer left to draw the shortage from — the movement is still written (a shelf is a shelf), the cost is flagged, never silently zero |
| `rejected` / `VALIDATION_ERROR` | `quantity < 0` (or otherwise outside the schema) |
| `rejected` / `FRACTIONAL_QUANTITY` | a whole-counted product was counted fractionally |
| `rejected` / `EMPTY_STOCKTAKE` | none of the named products exists at this branch |

Replaying the same `commandId` returns the stored result as `duplicate` — a shelf is never counted
twice for one sheet.

## Who may do what

- The sync push maps `Stocktake` to **`inventory.adjust`**: a count *produces* adjustments, so it is
  held to the permission that writes them. (The cashier role does not have it.)
- The command's `branchId` must be the device's enrolled branch — `BRANCH_MISMATCH` for the batch
  (ADR 0008 item 5): a count is a fact about the shelf this till stands in front of.
- Movements carry `actor_id` and `device_id`, and `GET /v1/inventory/movements?productId=…` returns
  `actor_id` / `actor_name` so the history names the person, not only the number.

## Surface

| | |
| --- | --- |
| `POST /v1/sync/push` | `Stocktake` commands — no new HTTP endpoint; a count must be queueable with no connection (§1.6 rule 1) |
| `GET /v1/inventory/movements?productId=…` | every movement, now with `actor_id` / `actor_name` |
| `GET /v1/inventory/balances?branchId=…` | the book the sheet's variance preview is shown against (server's book is authoritative) |

## In the app (Android)

- **Stock → Stocktake**: the sheet is built the way a shelf is counted — *Scan or type a barcode or
  SKU* adds a line (a scanner's Enter resolves it against Room), and *Count everything with stock (n)*
  prefills every stock-tracked product this branch holds above zero, for the full-stocktake case.
  Products with no book are counted by scanning them specifically, because "found stock" is a real
  outcome a pre-filled sheet cannot guess at.
- Each card shows the product, its **book**, a unit pill row for the products that have packs
  (`ea` / `crate` — a crate is 24 bottles of soda and 12 of water), the count field, and the variance
  **in words**: `Agrees with the book — writes nothing`, `26 ea short of the book`, `5 ea found`,
  with the pack conversion preview (`2 crate = 48 ea`) computed by the same `Units.convertQuantity`
  the server posts with. A count that is blank says *not counted yet — left out of the count*; a
  negative one is refused in place: *a count cannot be below zero*.
- The queue button counts what it will send (`Queue count (7 line(s), 3 differ)`) and stays disabled
  while any typed line cannot be a count. It works offline: the command is one outbox row
  (`aggregateType: Stocktake`), and the local projection is nudged by the variance the device sees so
  the screen does not contradict the sheet — the next pull replaces it with the server's figure (§6).
- **Movement history** labels these rows `Stock count` and shows who did it (`by Owner`) alongside
  the reason.

## Example

```bash
# Count: bread 20 (book 24), milk 30 (book 24) — one short, one found
curl -s -X POST http://localhost:3000/v1/sync/push -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"commands":[{
    "commandId":"…","branchId":"…","deviceId":"…","aggregateType":"Stocktake",
    "aggregateId":"9f0a…","schemaVersion":1,
    "payload":{"stocktake":{"id":"9f0a…","note":"Sunday night count","lines":[
      {"productId":"88888888-8888-4888-8888-888888888881","quantity":20},
      {"productId":"88888888-8888-4888-8888-888888888882","quantity":30}]}}}]}'
# -> {"results":[{"status":"accepted","result":{"countedLines":2,"varianceLines":2,
#      "matchedLines":0,"lostValueMinor":18000,"foundValueMinor":24000,…}}]}
# bread: movement -4 ea, reason "stocktake", actor Owner, cogs 4 × 4500 = 18000 (FIFO)
# milk:  movement +6 ea at the product's last known cost (6 × 4000 = 24000)
# a count of bread 20 again would write NOTHING: matchedLines 1, varianceLines 0
```

## Verification

- `apps/api/tests/integration/stocktake.spec.ts` — 11 checks: movements with reason **and** actor
  (plus the audit row and `actor_name` on the history endpoint); a matching line writes nothing;
  counted zero empties the shelf and books the loss at FIFO cost (layers consumed to 0); pack counts
  written as the pack when the variance divides exactly and in base units when it does not; weighed
  fractions accepted, counted-unit fractions refused whole; negative counts refused by validation;
  unknown lines dropped / all-unknown refused; idempotent replay; cashier `FORBIDDEN`; an uncosted
  shortage accepted for review with a durable `UNCOSTED_STOCK` conflict case.
- `npm run verify` — fixtures 74/74 and the whole API suite green.
- Android: clean `assembleDebug` under `--no-build-cache` with **zero** Kotlin warnings; the APK
  gate records the signed artifact in `phase-04-apk-record.md`.
