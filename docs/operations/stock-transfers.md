# Cross-branch stock transfers (item 4.7)

A shop with more than one branch (owner decision, ADR 0008) moves goods between them. The rule the
architecture gives that movement is one sentence:

> **Stock is in exactly one branch, or in transit on a document — never in both.**

So a transfer is **one document written by two branches**: the source *dispatches*, the destination
*receives*, and between those two moments the goods belong to neither shelf. The document carries the
quantities on both sides; the ledger only ever learns branch-local facts:

```
dispatch  ->  a NEGATIVE movement at the source  (FIFO layers consumed, the cost travels)
receive   ->  a POSITIVE movement at the destination (a layer opened at that carried cost)
```

At no instant is the same stock counted in two branches — the exit criterion for this item. A
shortage counted at the door is **not** a movement: those units already left the source, so the
difference stays on the document as a `discrepancy` until a supervisor's note says who accepted it.

## Tables

| Table | Row is | Uniqueness / checks |
| --- | --- | --- |
| `stock_transfers` | the document: both branches, status, note, supervisor note | `UNIQUE (tenant, reference)`; `from <> to`; status ↔ `received_at` |
| `stock_transfer_lines` | one product's quantity sent (and later, counted) | `UNIQUE (transfer_id, product_id)`; `quantity_dispatched > 0` |

The line holds `unit` (the base unit, item 4.6), `entered_unit` / `entered_quantity` when the
paperwork said `2 crate` and the ledger holds `48 ea`, and `unit_cost_minor` — the cost per **base**
unit stamped at dispatch (ADR 0009). `quantity_received` is `NULL` until counted: `0` means "nothing
of this arrived", `NULL` means "nobody has looked".

References come from the **tenant-wide** numbering series (`numbering_series` with `branch_id IS
NULL`, guarded by a partial unique index so two branches cannot mint the same number): `TRF-0001`,
allocated under the row lock so concurrent dispatches from two branches cannot collide.

## States

`dispatched` → `received` | `discrepancy`. Created **and** dispatched in one step — there is no
draft, no cancel, and **one receipt closes the document entirely**:

| Status | Means |
| --- | --- |
| `dispatched` | goods left the source; in transit on this document |
| `received` | counted at the destination exactly as sent |
| `discrepancy` | counted with an approved shortage (the shortfall stayed behind, documented) |

The document id is chosen by the device (UUID) so a dispatch can be built offline; the *reference*
is server-issued, because a device must never invent a number the tenant's series owns.

## Step 1 — dispatch (the source half)

Payload of the outbox command (`aggregateType: "StockTransfer"`):

```jsonc
{
  "action": "dispatch",
  "transfer": {
    "id": "<device-chosen uuid>",
    "toBranchId": "<uuid>",
    "note": "restock for the weekend",       // optional
    "approvalNote": "…",                     // required when it would push this branch below zero
    "lines": [ { "productId": "…", "quantity": 2, "unit": "crate" } ]   // quantity as TYPED
  }
}
```

What the server does, in order:

1. Resolves the destination (`UNKNOWN_BRANCH` — a UUID from another shop — or `SAME_BRANCH`).
2. Resolves **every** line before writing anything: a transfer is dispatched whole or not at all.
   Unknown products are dropped; if that empties it → `EMPTY_TRANSFER`. A pack that does not
   convert is rejected with the item 4.6 codes (`UNKNOWN_CONVERSION`, `FRACTIONAL_QUANTITY`, …).
3. **Stock guard.** Without an `approvalNote`, each line's *base* quantity must be ≤ on hand, else
   `INSUFFICIENT_STOCK` (conflict case `NEGATIVE_STOCK`) naming the SKU and the balance. With a
   supervisor note the guard is lifted — the same one rule and one outcome as a negative adjustment
   (ADR 0009) — and the resulting negative balance comes back as `review_required` +
   `NEGATIVE_STOCK` rather than a silent success.
4. Issues `TRF-nnnn`, inserts the document as `dispatched`.
5. Writes **one movement per line** through `applyMovement` with the *entered* quantity and unit
   (`quantityDelta: -2`, `unit: "crate"`) — the one conversion choke point (item 4.6) does the pack
   arithmetic — and `costMode: 'transfer'`, which records the FIFO allocations the cost came from
   but writes **no `cogs_minor`**: the goods left the shelves, they were not sold.
6. Stamps `unit_cost_minor = roundHalfUp(consumedCost / dispatchedQuantity)` per line (falling back
   to `products.cost_minor` when there were no layers to draw on — a branch must never hand goods
   over valued at nothing).

Result on accept: `{ transferId, reference, serverSeq, negative, uncosted, lineCount }`, status
`accepted` (or `review_required` with `NEGATIVE_STOCK` when it went below zero / was uncosted).

## Step 2 — receive (the destination half)

```jsonc
{
  "action": "receive",
  "transfer": {
    "id": "<the document's uuid>",
    "approvalNote": "one crate dented, wrote it off",   // required for ANY shortage
    "lines": [ { "productId": "…", "quantityReceived": 46 } ]
  }
}
```

| Rule | Code |
| --- | --- |
| The document exists and belongs to this tenant | `UNKNOWN_TRANSFER` (404 on a direct read) |
| The command's branch **is** the destination | `NOT_TRANSFER_DESTINATION` |
| It has not been counted already | `ALREADY_RECEIVED` |
| Every dispatched line is named — none invented, none omitted | `UNKNOWN_RECEIPT_LINE` / `MISSING_RECEIPT_LINE` |
| Received ≤ dispatched (a surplus is a supplier receipt) | `RECEIVED_MORE_THAN_SENT` |
| Any shortage arrives with a supervisor note | `OVERRIDE_REQUIRED` (conflict case `TRANSFER_SHORTAGE`) |

The refusal is *before* anything is written, so nothing half-applies. On accept, each counted line
becomes a positive movement at the destination opened at **the cost that travelled with the goods**
(the source's layers gave it up at exactly that amount — the two sides cannot disagree), the
document closes as `received` or `discrepancy`, and the shortfall's value leaves with it (its Phase
8 posting hook is noted for later: the loss must eventually be accounted for, not merely displayed).

## Who may do what

- Both halves and `GET /v1/inventory/transfers` need **`inventory.transfer`**; the sync push maps
  `StockTransfer` commands to the same permission.
- The list is queried with `branchId`, which must be the device's enrolled branch — otherwise
  `403 BRANCH_MISMATCH`. A till reads its own branch's documents: what it sent and is waiting on,
  and what is coming to it. The **all-branch consolidated view belongs to the Phase 9 owner
  dashboard** (ADR 0008 item 5), not to a till.
- `sync.pushOne` resolves the device's branch once per batch: a command claiming any branch other
  than the enrolled one is refused `BRANCH_MISMATCH` for the whole batch, so a compromised or
  misconfigured device cannot write another branch's ledger.
- A session with **no device** (an operator at a desk) may read any branch of its own tenant —
  Phase 9 stands on this.

## Surface

| | |
| --- | --- |
| `GET /v1/inventory/transfers?branchId=…&limit=500` | this branch's documents, newest first |
| `GET /v1/config/snapshot` | already carries `branches`, so the destination picker needs no new endpoint |
| `GET /v1/inventory/balances?branchId=…` | what the device asks for since 4.7 — its own shelf, so two branches never collapse into one projection |
| `POST /v1/sync/push` | `StockTransfer` commands, `action: dispatch \| receive` |

The list view (camelCase on the wire):

```jsonc
{
  "id": "…", "reference": "TRF-0001",
  "fromBranchId": "…", "toBranchId": "…",
  "fromBranchName": "West Kiosk", "toBranchName": "South Kiosk",
  "status": "dispatched", "note": null, "approvalNote": null,
  "dispatchedAt": "2026-…Z", "receivedAt": null,
  "lineCount": 2, "inTransitQuantity": 72, "shortageQuantity": 0,
  "lines": [ {
    "productId": "…", "sku": "SKU-008", "name": "…", "unit": "ea",
    "enteredUnit": "crate", "enteredQuantity": 2,
    "dispatched": 48, "received": null, "unitCostMinor": 5500, "shortage": 0
  } ]
}
```

`inTransitQuantity` is non-zero only while the document is open; `shortageQuantity` is what the
destination came up short once counted (0 while nobody has counted).

## In the app (Android)

- **Stock → Cross-branch transfers**: two direction pills — *Sent from here (n)* and *Coming here
  (n)* — over one list. Each card shows the status in words (`Waiting at destination`, `Waiting for
  your count`, `Received`, `Arrived short`), the other branch's name, every line with what was
  written on the paperwork (`2 crate`), what left, what arrived and how far it came up short, plus
  the document's timestamps, notes and this device's own sync state in words: `Queued — pending on
  this device`, `Last synced …`, `Needs attention — INSUFFICIENT_STOCK` with the server's sentence.
  A summary banner counts what is `Pending on this device (n)` and `Needs attention (n)`.
- **Send stock** (source): destination picked from the cached branch list (works offline), lines
  added by scanning a barcode or typing a code — the scanner's Enter resolves it against Room — then
  a quantity dialog offering the product's pack sizes with the conversion preview
  `2 crate = 48 ea`, computed with the same `Units.convertQuantity` the server posts with. The draft
  line keeps both numbers and shows on-hand and what it leaves behind. When the dispatch would take
  this branch below zero, a **supervisor note becomes required** before the button enables — the
  server's rule, asked for before the queue rather than after the rejection.
- **Count what arrived** (destination): every dispatched line prefilled with what was sent (the
  server refuses a receipt that omits or invents a line), an over-count blocked in place with the
  "that belongs on a supplier receipt" sentence, and any shortage raising the required supervisor
  note.
- **Stock rows**: an *In transit from this branch* section under the list — units that have left
  this branch's balance and not yet been counted at the destination, named by document (`TRF-0001`,
  or "queued on this device"), so the shelf can see what it cannot count.
- Everything queues: dispatch and receipt are outbox commands (`aggregateType: StockTransfer`,
  dispatch and receipt sharing the document's `aggregateId`), posted by the next sync with the same
  commandId, and the transfer list is refreshed after push+pull like the balance projection.

## Example

The demo seed ships the pair this runs against — **Main Kiosk** (holding stock) and **West Kiosk**
(deliberately empty), because there is no branch-creation endpoint yet (see the limitations note in
`phase-04-apk-record.md`). One phone plays both shelves: Settings → *Branch id* → enrol at Main, send,
sync; then re-enter the branch id `22222222-2222-4222-8222-222222222223` and *Set up* again —
enrolment moves the same device to the other branch (`device.re-enrolled`) and the document reappears
under *Coming here*.

```bash
# Dispatch: 2 crates of SKU-008 from Main Kiosk to West Kiosk
curl -s -X POST http://localhost:3000/v1/sync/push -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"commands":[{
    "commandId":"…","branchId":"…","deviceId":"…","aggregateType":"StockTransfer",
    "aggregateId":"1a2b…","schemaVersion":1,
    "payload":{"action":"dispatch","transfer":{
      "id":"1a2b…","toBranchId":"22222222-2222-4222-8222-222222222223",
      "lines":[{"productId":"88888888-8888-4888-8888-888888888808","quantity":2,"unit":"crate"}]}}}]}'
# -> {"results":[{"commandId":"…","status":"accepted",
#      "result":{"transferId":"…","reference":"TRF-0001","lineCount":1,…}}]}

# Count it short (46 of 48) with the note the server demands
curl -s -X POST http://localhost:3000/v1/sync/push -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"commands":[{
    "commandId":"…","branchId":"<west>","deviceId":"…","aggregateType":"StockTransfer",
    "aggregateId":"1a2b…","schemaVersion":1,
    "payload":{"action":"receive","transfer":{"id":"1a2b…",
      "approvalNote":"one crate dented on the road",
      "lines":[{"productId":"88888888-8888-4888-8888-888888888808","quantityReceived":46}]}}}]}'
# -> status "accepted" (a short count WITH a note) and the document reads status "discrepancy"
```

## Verification

- `apps/api/tests/integration/transfers.spec.ts` — 18 checks: both halves end to end; the ledger
  claims (dispatch writes `transfer_out` at the source only, receipt opens a destination layer at
  the carried cost, in transit is counted nowhere, the entered pack is remembered, the shortage
  leaves as a documented discrepancy and not a movement); every refusal code above; tenant and
  branch scoping (`BRANCH_MISMATCH`, a desk session reading any branch); numbering from the tenant
  series; idempotent replay of a dispatch.
- `npm run verify` — fixtures 74/74 and the whole API suite green.
- Android: clean `assembleDebug` under `--no-build-cache` with **zero** Kotlin warnings; the APK
  gate records the signed artifact in `phase-04-apk-record.md`.
