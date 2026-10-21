# Phase 4 — APK delivery record

Required by §15 "Mandatory Android APK delivery gate". Every field below is part of the gate.

| Field | Value |
|---|---|
| **Phase** | 4 — Catalogue, pricing/promotions and inventory (+ post-phase polish) |
| **App version** | `0.4.11` (versionCode 411) |
| **Artifact** | `artifacts/retail-erp-p04-v0.4.11.apk` |
| **SHA-256** | `b51076a30aa66e7d56f2e539281031f850c6c15b91084a2539580cbc5b503872` |
| **Size** | ~42.4 MB (42,427,577 bytes; bundled ML Kit barcode models, unminified debug build) |
| **Signing** | **Stable internal-test key** (`CN=Kiosk ERP Internal Test`, cert SHA-256 `935c0fbc6993db9ca761b4c3610c71a50d91897fd9b1753d0da3e56dffd056dd`), generated once by `build-apk.sh` and git-ignored (ADR 0005) |
| **Build** | Docker image `kiosk-erp-android-builder` (JDK 17 + Android SDK 34 + Gradle 8.7); `PHASE=04 VERSION=0.4.11 bash infra/docker/android/build-apk.sh` |
| **Expected backend** | `apps/api` on `http://<host>:3000/v1` with migration `0008`; seed tenant + **two** branches (Main Kiosk, and West Kiosk — item 4.7's second shelf) and a 20-product demo catalogue with 9 units, 3 brands, 4 pack sizes, 5 low-stock thresholds and 2 price lists — see `demo-catalogue.md` |

**Build history inside Phase 4** (each is signed with the same stable key, so each upgrades in place):

| Version | versionCode | SHA-256 (first 16) | What it added |
|---|---|---|---|
| `0.4.1` | 401 | `74caefeab641af20` | Catalogue management UI, dated promotions, inventory movements, multi-module split, launcher icon |
| `0.4.2` | 402 | `65580399f57da74e` | Offline camera scanner (5.1), FIFO valuation (ADR 0009), barcode editing, catalogue import file picker, per-product movement history |
| `0.4.3` | 403 | `cb6bbe8d363fa843` | UI usability pass: `:core:designsystem`, redesigned Home / Till / Stock / Sync / Setup / Catalogue / Licence |
| `0.4.4` | 404 | `9e45a6a88b151008` | Scan-to-add made reliable (catalogue pulls itself on enrol/sync, paged fetch), scanner-first till, Products row on Home, 20-product demo catalogue |
| `0.4.5` | 405 | `804f15d75709a7c8` | Opening-stock import (4.5): `POST /v1/inventory/opening-stock/import` + Stock → Opening stock screen (file picker or typed lines) |
| `0.4.6` | 406 | `d75d408280de6bed` | Units of measure + pack sizes + brands (4.6): conversion at every ledger write, pack picker in the adjust dialog, Manage gains Units & Brands |
| `0.4.7` | 407 | `31764202b6a0a00e` | Cross-branch transfers (4.7): dispatch/receipt documents, direction pills, send + count screens, in-transit under Stock rows, branch-scoped balances |
| `0.4.8` | 408 | `fc2002a0de9dca37` | Stocktakes (4.8): count sheet with pack pills and variance in words, counted-not-delta payloads, `Stock count` + who did it in history |
| `0.4.9` | 409 | `c34727167daf71e3` | Scan-to-add a product (auto SKU) + physical-phone setup guidance |
| `0.4.10` | 410 | `b6637e087792e7a9` | Low-stock thresholds (4.9): reorder point on the product, Stock-screen breach banner + `LOW`/`OUT` pills computed offline, editor field, bulk-set via import |
| `0.4.11` | 411 | `b51076a30aa66e7d` | Price lists (4.11): dated branch-scoped overrides, scheduled flips computed offline on the device, `price_version`, price-change history in the editor, stale-price warnings widened to every source |

> **Upgrade note.** Phase 3's APK was signed with the throwaway Android debug key, so it **cannot be
> upgraded in place** by this build (signature mismatch) — uninstall the Phase 3 build first. This is
> the last time that happens: every APK from Phase 4 onward is signed with the stable internal-test
> key, so upgrades preserve on-device data.

## Changelog

Server (`apps/api`):

- **Migration `0003`**: `promotions` (dated windows, product- or category-scoped, `percent_off` /
  `amount_off` / `fixed_price`) plus `inventory_movements.approved_by` / `approval_note`.
- **Pricing resolver** (`PricingService`): a pure function of `(product, quantity, asOf)`. Dated
  promotions mean a sale can be re-priced against the policy that was live when it was rung up.
  `GET /v1/pricing/resolve`.
- **Inventory** (`InventoryService`): one append-only write path (`applyMovement`) shared by sales,
  receipts and adjustments. `StockAdjustment` requires a reason, and a decrease that would take stock
  negative additionally requires `approvedBy` / `approvalNote`. Read models `GET /v1/inventory/balances`
  and `/movements`; `GET /v1/inventory/:id/movements` gives a product's full history (item 4.10).
  - **Costing superseded by ADR 0009.** Weighted average — as this record originally described — was
    replaced by **FIFO with valuation layers** (migration `0004`): `inventory_valuation_layers` holds
    each receipt tranche, `inventory_movements.cogs_minor` records the derived cost of each outbound
    movement, `GET /v1/inventory/valuation` reports the position, and opening stock is seeded as
    movements + layers so balance, ledger and valuation agree from the first sale.
- **Bulk catalogue import** (item 4.4): `POST /v1/products/import` runs one pure planner for both
  preview and commit, so the report an operator approves is exactly what a commit does; a file with
  any bad row writes **nothing**. RFC 4180 reader with `line` numbers that match the operator's
  spreadsheet, `409 DUPLICATE_BARCODE` on clashing barcodes, and 18 unit + 8 endpoint tests.
- **Catalogue editing**: `PATCH /v1/products/:id` with optimistic `expectedVersion`, plus
  `tax-categories` and `categories` CRUD. Product deltas are emitted as `product.created` /
  `product.updated` server events carrying the exact client DTO.
- **Catalogue now carries real tax**: product queries join `tax_categories` and expose `tax_rate_bp`
  and `tax_inclusive` — no more client-side default rate.
- **Sales price-snapshot review**: posting resolves the live price and flags `STALE_PRICE_SNAPSHOT`
  as a warning while always keeping the sale-time snapshot (never silently re-prices).
- **Server-side authority on synced commands**: each aggregate declares a required permission
  (`Sale` → `pos.sale.create`, `StockReceipt` → `inventory.receive`, `StockAdjustment` →
  `inventory.adjust`); a device token is not proof of authority. Denied commands return
  `rejected` / `FORBIDDEN`.
- **Centralised exception handling**: every `conflictCodes` value from any aggregate becomes a
  durable `conflict_cases` row inside the push transaction.

Android (`apps/android`):

- **Multi-module split (ADR 0007)**: `:app` (composition root) + `:core:{common,database,network,security,data}`
  + `:feature:{dashboard,pos,catalog,inventory,sync,license,settings}`, with a Gradle version catalog
  and dependencies pointing strictly inward.
- **Stable internal-test signing key** generated once by `build-apk.sh` and git-ignored (ADR 0005), so
  APKs upgrade in place from this phase onward.
- New **Stock** tab: cached on-hand projection, refresh-from-server, and offline stock adjustments
  (signed delta + mandatory reason) queued in the outbox.
- Room **version 2** with a real, data-preserving `MIGRATION_1_2` — a destructive fallback was
  explicitly rejected because the local DB also holds unsynced sales.
- `SyncEngine` now **applies catalogue deltas** (`product.created` / `product.updated`) while pulling,
  and refreshes the balance cache after each sync (a balance failure never fails the sync).
- Product cache is populated from synced tax categories instead of a hard-coded rate.
- `ApiClient` returns typed auth results, so feature modules no longer parse raw JSON.

Post-phase polish (owner-requested, `docs/operations/roadmap.md` P1–P2):

- **Launcher icon added.** There was none, so Android was showing its default robot. Now an adaptive
  icon (teal background + white receipt mark, with a `monochrome` layer for themed icons), referenced
  from the manifest as `icon` and `roundIcon`.
- **Bottom navigation cleaned up.** Seven tabs exceeded Material's 3–5 guidance, so the two occasional
  administrative screens (**Catalogue**, **License**) moved behind the **Setup** hub. Primary tabs are
  now **Home · POS · Stock · Sync · Setup**, with the bar staying highlighted while browsing an
  admin screen.

Phase 4 close-out (`0.4.2`):

- **Offline camera scanning (5.1)**: ML Kit barcode models bundled in the APK, CameraX preview with a
  scan overlay, and a manual-entry fallback. A successful scan now visibly adds the item (the original
  overlay bug where nothing appeared to happen was fixed).
- **Catalogue import file picker** (item 4.4, device side): pick a CSV/JSON file → show the *server's*
  row-by-row preview → commit only when the report is valid; an invalid file commits nothing and stays
  on screen with its problems.
- **Barcode set editing** (item 4.1 / D9): the editor and the device cache replace a product's barcode
  set rather than only ever adding to it, and the payload no longer drops `tax_category_id`.
- **Per-product movement history** (item 4.10) in the Stock tab: source, signed quantity, reason, date
  and costed-out losses, read from the server ledger rather than reconstructed locally.

UI usability pass (`0.4.3`, owner-requested before continuing — full detail in `master-plan.md` §4):

- **New `:core:designsystem` module** (D27a): `Banner` (offline/saved/failed), `Pill` (status word +
  tone), `EmptyState`, `ErrorState` with retry, `LoadingState`, `StatTile`, `DetailRow`, `NavRow`,
  `SectionTitle`, `ScreenHeader`, plus a theme-aware `Tone`. **Every state is named in words, never
  implied by colour alone**, and the tones flip polarity between light and dark so a status chip stays
  readable in sunlight.
- **Typography scale** raised (body 15sp, weight-based hierarchy) for arm's-length reading at the till.
- **Home**: §7's money split made visible — *Accepted by the server* beside *Waiting to upload*
  (provisional, labelled as such); a sync card that reports **connection and queue as separate rows**
  (§16: a green network icon is not enough); recent sales with per-sale state pills; an enrolment
  banner that routes to Setup when the device cannot sync yet.
- **Till**: "Test item" scaffolding buttons removed; a `Find items ⇄ Cart` toggle so a 20-line basket
  still shows the total; quantity steppers and a remove button on cart lines; inactive products hidden
  and refused; scan outcome shown as a dismissible success/error banner; clearing the cart asks first;
  empty states name the next step.
- **Stock**: on-hand per product leads the screen, with search and an adjust dialog that shows
  *current → after this change* and warns when it would go negative (which the server would send back
  for supervisor review).
- **Sync Center**: headline status word, then `Waiting to upload` and `Connection` as **separate
  facts**, needs-attention cards that translate each conflict code into the next action, the waiting
  queue, and a `Diagnostics` section so the support-only test command is no longer mixed in with
  normal controls.
- **Setup**: sections with plain-language captions, a Ready-to-sync / Not-enrolled pill, the two opaque
  UUIDs moved into a labelled *Device identifiers* block, correct keyboard types + password masking,
  and disabled/progress states on enrol.
- **Catalogue**: search with clear, All/Active/Inactive filter, right-aligned price, overflow menu for
  edit/deactivate, dismissible result banners, sectioned product editor, and an import preview headed
  by a valid-or-problem pill.
- **Licence**: explains what each of the two cryptographic boxes is, refuses to run an incomplete pair,
  and reports the outcome as one word before the detail.
- **Accessibility**: content descriptions on every icon, ≥44–48dp primary targets, error text never
  truncated, no state conveyed by colour alone.

Scan-to-add + demo catalogue (`0.4.4`, owner-requested before continuing to 4.5):

- **The till's catalogue now fills itself.** Enrolment finishes with a first sync, and `SyncEngine`
  refreshes the catalogue whenever a pull carries a product event **or** the device has none at all.
  The second half was the actual bug behind "scan adds nothing": a shop that was already live — and
  the dev seed, which writes no `server_events` — emits no product deltas, so a brand-new till pulled
  an empty feed, showed an empty product list and answered every scan with "no product matches" until
  somebody found Setup → Catalogue → Refresh by hand. A failed catalogue refresh still never fails a
  sync: commands are the critical path, caches are conveniences.
- **Catalogue fetch walks every page.** It requested `products?limit=500` exactly once, so anything
  past the server's 500-row ceiling was invisible to the scanner; it now pages until the server returns
  a short page, with an explicit ceiling so a bad response cannot spin.
- **Scanner-first till** (§5): a full-width *Scan a barcode* button now sits ahead of the search box on
  both halves of the loop, so a till driven by a barcode gun never has to touch the keyboard. The
  header's lone Scan button was removed rather than duplicated.
- **Scan results confirm themselves.** The banner names the item, the cart count and the running total
  — "Added Sugar 1kg · cart 3 items · 540.00 KES" — instead of only the product name, so "did it
  add?" is answerable without hunting for a badge. An unknown code now says what to do next.
- **Home gained a Products row**, so browsing the catalogue is one tap from the first screen instead
  of a trip through Setup.
- **Demo catalogue** (`seed-dev.ts`, documented in `docs/operations/demo-catalogue.md`): 20 products
  across 5 categories, 18 barcodes (one item carrying two tags, two carrying none), 16 further
  opening-stock movements + FIFO valuation layers, a zero-rated tax category beside VAT 16%, an item
  that is not stock-tracked, an item with no stock at all and a deactivated item that must never
  reach the till. The two original seeded barcodes are untouched — they are pinned by the test suite —
  and every tag added since is a valid EAN-13. The seed stays idempotent.

Opening-stock import (`0.4.5`, item 4.5):

- **Server**: `POST /v1/inventory/opening-stock/import` (permission `inventory.receive`) with
  `branchId`, `requestId`, and either `csv` or `records`. A pure planner
  (`opening-stock-import.ts`) decides the whole file before the transaction opens; preview and commit
  run it, and a file with any bad row reports every bad row and writes **nothing**. The report carries
  `onHandBefore` / `onHandAfter`, unit cost, line value and file totals, plus three warnings that
  inform without blocking (`OPENING_ALREADY_PRESENT`, `OPENING_COST_UNKNOWN`,
  `BRANCH_ALREADY_TRADING`).
- **Opening balances are movements, never an edit.** Each line appends an `inventory_movements` row
  (`reason: 'opening'`, `source_type: 'opening_stock'`) through the one write path
  (`applyMovement`), which also opens the FIFO valuation layer that costs that stock from day one.
  `stock_balances` remains a derived projection — a test asserts the stored quantity equals the sum
  of its movements. A cost stated in the file updates `products.cost_minor`; an omitted cost never
  rewrites it. Commit is audited as `opening_stock.imported`.
- **One `requestId` per file chosen** becomes each movement's `source_id` / `command_id`, so a commit
  that times out and is retried reports `alreadyApplied: true` instead of opening the stock twice;
  the ledger's unique index on `(tenant, command, product, source)` is the backstop.
- **Shared CSV vocabulary** (`domain/csv.ts` gained `canonicalColumn` / `recordsToCsvRows`), so both
  importers resolve headers and JSON records through one implementation rather than two that could
  drift.
- **Device**: Stock → **Opening stock** — pick a CSV/JSON file or type the lines (`SKU-003,40`, the
  header supplied if omitted) → read the server's report (readiness pill, line/unit/value totals,
  warnings, problems, and every planned line as *on hand before → after* with its value) →
  **Import N line(s)**. Success refetches the balances so the Stock list shows the new on-hand, and a
  replayed commit says *already imported*. Documented in
  `docs/operations/opening-stock-import.md`.

Units of measure, pack sizes and brands (`0.4.6`, item 4.6):

- **Migration `0005`**: `units_of_measure` (`code`, `name`, `kind` = count/weight/volume, unique per
  tenant ignoring case), `unit_conversions` (product-scoped pack sizes: `1 <unit> = <factor>
  products.unit`, positive and finite, unique per product, validated against the vocabulary at write
  rather than by a FK), `brands` + `products.brand_id`, and on every movement
  `entered_unit` / `entered_quantity` — recorded **only when a conversion happened**, with a CHECK
  keeping the two null together.
- **One conversion point.** `InventoryService.resolveQuantity` resolves a quantity against the
  product's base unit before any movement is written, so `applyMovement` — the single write path for
  receipts, adjustments and opening stock — can only ever store `quantity_delta` in `products.unit`
  while remembering what the paperwork said. `receiveStock` and `adjustStock` resolve every line
  *first*, so a receipt naming one unknown pack is refused whole with nothing received; a supervisor
  override on a negative adjustment is checked against the **base** quantity.
- **Costs stay per base unit.** A quoted `unitCostMinor` is per the unit on the line and is divided by
  the factor into cost-per-base before it reaches a FIFO layer or `products.cost_minor` — so
  `10 crate @ 24000` costs 24,000 a bottle and opens one layer, not ten.
- **The base-unit rule.** A quantity typed in the product's own unit is held to the same rule as a
  converted one: `0.5 ea` is refused for a counted product, while a weighed product takes `12.5` kg
  as it always did. Where a unit's kind is unknown the ledger deliberately invents **no** rule
  (`unit_kind: null`) — guessing `count` would refuse a legal weigh whose unit nobody had typed.
- **Conversion contract** (`domain/units.ts`, mirrored in `Units.kt` and `Units.swift`): round half-up
  to 3 decimals, refuse a non-whole `count` (`FRACTIONAL_QUANTITY`), refuse unusable factors or
  non-finite quantities, and return a **code** rather than a message. Checked against
  `fixtures/unit-conversion.json` — **74/74 checks**.
- **Units and brands are endpoints**: `GET`/`POST /v1/units`, `GET`/`POST /v1/brands`
  (`catalog.manage` for writes), plus `units` and `brands` on `GET /v1/config/snapshot`. No new
  server events — this is configuration, read with the product payload.
- **Product payloads** gain `brand_id`, `brand_name`, `unit_kind` and the `conversions` SET;
  `PATCH`/`POST` accept `brandId` and `conversions` (replace semantics, exactly like `barcodes`).
  Changing a product's selling unit re-validates the packs already stored instead of stranding them.
- **Catalogue import**: the optional `brand` column (aliases `brand_name`, `manufacturer`), matched
  ignoring case; unknown brands are an error unless `createMissingBrands: true`, reported under
  `brandsToCreate`.
- **Opening-stock import**: the optional `unit` column — `SKU-008,10,crate` previews as
  `10 crate → 240 ea`, costs divide to a per-bottle layer, and `UNKNOWN_CONVERSION` /
  `FRACTIONAL_QUANTITY` / `UNKNOWN_UNIT` are reported per row. Preview and commit share the planner,
  so a preview never promises what its own commit refuses.
- **Tests**: new `units-conversions.spec.ts` (unit/brand CRUD, tenancy 404s, 422 validation, the SET
  rule and its refusals, a receipt in crates landing as one base-unit layer, weighed fractions,
  overrides measured in base) plus import and planner cases for the new columns.

Device:

- **Room v4** (`MIGRATION_3_4`, additive): `products.brandId` / `brandName` / `unitKind` and a
  `product_conversions` table replacing the product's pack set wholesale on each pull — a pack
  retired on the server must stop converting on a till that has not synced.
- **Product editor**: a **Pack sizes** section (`1 crate = 24 ea`, add/remove), a brand picker, and a
  unit picker for the selling unit; saving sends the whole barcode and conversion sets and the brand.
- **Catalogue → Manage** now manages the shop's reference data: units (code, name, kind — chosen, not
  typed) and brands alongside categories and tax rates.
- **Stock → Adjust** offers the product's pack sizes read from Room (so it works offline) and previews
  the conversion with the *same* `Units.convertQuantity` the server posts with — `10 crate = 240 ea`
  above `→ 240 ea on hand after this is queued`. An impossible conversion blocks the button with the
  reason in words rather than queueing a command the server would reject. The queued command carries
  the quantity **as typed with its unit**; only the device's own on-hand projection uses the base
  number, because the server is the one that converts for the ledger.
- **Opening stock** reports the pack beside the base quantity (`10 crate → 240 ea`), and **movement
  history** shows `10 crate → +240 ea` on movements that were converted. Stock rows label on-hand in
  the product's own unit.
- Documented in `docs/operations/units-and-conversions.md`, with the import columns in
  `catalogue-import-format.md` and `opening-stock-import.md`.

Cross-branch stock transfers (`0.4.7`, item 4.7 / ADR 0008):

- **Migration `0006`**: `stock_transfers` (unique `(tenant, reference)`, `from <> to` by CHECK, status
  tied to `received_at`) and `stock_transfer_lines` (unique per document **and product**,
  `quantity_dispatched > 0`, `quantity_received` NULL until counted, `unit_cost_minor` = the cost per
  **base** unit that travelled with the goods), plus a partial unique index that makes
  `numbering_series` tenant-wide for branch-less series so two branches cannot mint one `TRF-` number.
- **One document, two per-branch steps.** `dispatched` → `received` | `discrepancy`: created *and*
  dispatched in one command (no draft, no cancel), and **one receipt closes it entirely**. The
  document id is device-chosen (so a dispatch works offline) while the reference is server-issued
  from the tenant series (`TRF-0001`).
- **Conservation, not bookkeeping.** A dispatch writes a *negative* movement at the source
  (`reason: 'transfer_out'`, `costMode: 'transfer'` — FIFO allocations recorded, **no `cogs_minor`**:
  the goods left, they were not sold) and stamps `unit_cost_minor = roundHalfUp(consumed /
  dispatched)`, falling back to `products.cost_minor` when nothing was costed. A receipt writes a
  *positive* movement at the destination (`reason: 'transfer_in'`) opening a layer at that same
  carried cost. In transit belongs to **neither** branch — a test counts the shop's total stock across
  every branch before and after both halves and finds it changed only by what was received short.
- **Every line resolved before anything is written**, twice: `EMPTY_TRANSFER` when no line survives
  the source, `UNKNOWN_TRANSFER` / `NOT_TRANSFER_DESTINATION` / `ALREADY_RECEIVED` /
  `MISSING_RECEIPT_LINE` / `UNKNOWN_RECEIPT_LINE` / `RECEIVED_MORE_THAN_SENT` at the door. The stock
  guard runs in base units per line (`INSUFFICIENT_STOCK` + conflict `NEGATIVE_STOCK`) and is lifted
  only by an `approvalNote`; any shortage on a receipt needs one too (`OVERRIDE_REQUIRED` + conflict
  `TRANSFER_SHORTAGE`) and lands as `review_required` + `discrepancy`. A shortage is recorded **on the
  document only** — never a second movement.
- **Branch discipline** (ADR 0008 item 5): `sync.pushOne` resolves the device's branch once per batch
  and refuses any command claiming another (`BRANCH_MISMATCH`); `GET /v1/inventory/transfers` takes a
  `branchId` checked against enrolment (403 on mismatch) and returns only documents the device's own
  branch is source or destination of; a session with **no device** may read any branch of its tenant —
  the consolidated cross-branch view is Phase 9's owner dashboard. Permission `inventory.transfer`
  covers both halves and the list.
- **Seed**: a second demo branch, **West Kiosk** (`22222222-2222-4222-8222-222222222223`), shipped
  **empty** so one phone can send goods across a branch line and count them arriving — there is
  deliberately no branch-creation endpoint yet.

Device:

- **Room v5** (`MIGRATION_4_5`, additive): `stock_transfers` (branch names, status, note, supervisor
  note, timestamps, line/in-transit/shortage counts, a `synced` flag so only server-known documents may
  be pruned), `stock_transfer_lines` (composite key), `branches` + their DAOs. Branches replace
  wholesale on each snapshot, but an empty snapshot never erases the destination picker.
- **Outbox**: `aggregateType: StockTransfer` where dispatch and receipt share the document's
  `aggregateId`; each command writes the local document in the same transaction it queues in —
  dispatch decrements the shelf (`synced = false`), receipt optimistically credits the destination —
  so the screen never claims stock that has not moved even one byte toward the server.
- **Stock → Cross-branch transfers**: direction pills (*Sent from here (n)* / *Coming here (n)*), a
  summary banner with `Pending on this device (n)` and `Needs attention (n)`, and per document a card
  carrying status in words, the other branch, every line with what was written (`2 crate`), what left,
  what arrived, per-line shortage, the notes, and this device's sync state in words — `Queued — pending
  on this device`, `Last synced …`, `Needs attention — INSUFFICIENT_STOCK` plus the server's sentence.
- **Send stock** (source): destination picked from the cached branch list (works offline), lines found
  by scan or IME search against Room, a quantity dialog offering the product's packs with the same
  conversion preview the server posts with (`2 crate = 48 ea`), on-hand and *left after* per line, and
  a **supervisor note that becomes required exactly when the dispatch would push the shelf below zero**
  — the server's refusal asked for before the queue rather than after it.
- **Count what arrived** (destination): every dispatched line prefilled with what was sent, over-count
  blocked in place (*that belongs on a supplier receipt*), any shortage raising the required note.
- **Stock rows** gained an *In transit from this branch* section naming the documents carrying what the
  shelf can no longer count, and **balances are fetched for this device's branch**, so one shop with
  two shelves never sees one branch's stock replace another's in the projection.
- Documented in `docs/operations/stock-transfers.md`.

Stocktakes / cycle counts (`0.4.8`, item 4.8):

- **No new table** — a count is movement machinery pointed at the one number nobody else can answer.
  `StocktakeSchema` carries **counted** quantities (`quantity >= 0`, never a delta): "the shelf holds
  20" is a fact about the shelf, so the variance is derived per line against the **server's** book —
  a device whose cached projection has drifted would otherwise post a number nobody read.
- **Agreement writes nothing.** A line matching the book reports `matchedLines` and leaves no
  movement (float dust counts as agreement, so a scale cannot fill history with `4e-15 kg` rows);
  a differing line becomes one movement through `applyMovement` with `reason: 'stocktake'`,
  `source_type: 'stocktake'`, `source_id` = the count's id and the caller's `actor_id` — §15's "a
  count produces adjustment movements with reason and actor".
- **The pack survives only when it divides.** A variance that is a whole number of packs is written
  in the counted unit (`entered_unit`/`entered_quantity`), any other variance in base units: a
  fraction of a crate is not something a shelf can hold. Short variances consume FIFO layers and book
  `cogs_minor` (shrinkage costs shillings too); found stock opens a layer at `products.cost_minor`
  rather than zero; an uncosted shortage is `review_required` + conflict `UNCOSTED_STOCK` with
  `cogs_minor` left `NULL` — *never costed* is a different claim from *costed at nothing*.
- **No override by arithmetic.** `quantity >= 0` means a count can never push stock below zero, so
  unlike an adjustment it asks for no supervisor note; the refusals are about a count that was never
  a number — `VALIDATION_ERROR` (negative), `FRACTIONAL_QUANTITY` (`20.5 ea`), `EMPTY_STOCKTAKE`
  (nothing named exists here; unknown lines are dropped so a stale cache cannot block a real count).
  All lines resolve before anything is written, and replaying a `commandId` returns `duplicate`.
- **Permission and branch**: `Stocktake` maps to `inventory.adjust` (a count *produces* adjustments)
  and is constrained to the enrolled branch by `sync.pushOne` (`BRANCH_MISMATCH`); audit row
  `stock.counted` (tallies + note), server event, outbox event. `GET /v1/inventory/movements` now
  returns `actor_id` / `actor_name` for **every** movement — history can name the person.

Device:

- **Stock → Stocktake** count sheet: *Scan or type a barcode or SKU* adds a line (scanner's Enter
  resolves against Room), *Count everything with stock (n)* prefills the full-stocktake case (zero
  book excluded — found stock is counted by scanning the product specifically), each card carries
  the product, its **book**, unit pills for products with packs, and the count field with the
  variance **in words**: `Agrees with the book — writes nothing`, `26 ea short of the book`,
  `5 ea found`, plus the same `2 crate = 48 ea` conversion preview the server posts with. Blank lines
  say *not counted yet — left out of the count*; negative or unparseable entries are refused in
  place, and the button counts what it will send (`Queue count (7 line(s), 3 differ)`).
- **One `Stocktake` outbox command per sheet** (id device-chosen, works with no connection); the
  local projection is nudged by the variance the device sees so the screen never contradicts the
  sheet, and the next pull replaces it with the server's figure. Per-sheet pack lookups are read
  from Room (`sheetPacks`) so the pills work offline.
- **Movement history** labels these rows *Stock count* and shows `by <name>` — the actor line added
  with the endpoint change.

Scan-to-add a product + physical-phone setup (`0.4.9`, owner request):

- **A blank SKU means "name this one for me".** `POST /v1/products` accepts an absent or empty
  `sku` and takes the next free `SKU-\d+` for the tenant from what it already holds (the seed tops
  out at `SKU-020`, so the first scan-created product is `SKU-021`); non-conforming SKUs (`PH4-NEW-1`,
  `BREAD`) are ignored rather than tripped over, and the zero-padding follows the widest number in
  use. Generation happens **inside the create transaction**, and a `UNIQUE (tenant, sku)` violation
  from a concurrent create is retried with the next number instead of surfaced — two tills pressing
  save at the same instant both end up with a product. An explicit `sku` behaves exactly as before,
  duplicates included (`DUPLICATE_SKU`, 409).
- **A cleared SKU on an edit keeps the product's own** — a rename to nothing is not a rename; a
  padded one is the same SKU with the spaces trimmed. (Previously `sku: ""` on `PATCH` would have
  written an empty string.)
- **Catalogue scan-to-add**: scan a tag into the catalogue search — a hit opens the product as
  before; a miss (digits only, 6–14) now offers **Create product with this barcode**, which opens
  the editor with that barcode already attached and the SKU field blank. Save shows
  `<name> saved as <sku>` so the generated number is visible the moment it exists. The SKU field's
  placeholder says what blank does (`blank = auto-generate` / `blank = keep current`), and validity
  no longer requires a SKU — name + selling price save.
- **Scanner-first barcode entry in the editor**: the *Add barcode* field now treats the scanner's
  trailing Enter (`imeAction = Done`) as **Add** — focus, pull the trigger, done (§5).
- **Physical-phone setup help.** The default address `http://10.0.2.2:3000/v1` is the **emulator's**
  alias for the development computer and resolves to nothing on a real handset — the most common
  reason a brand-new device cannot be set up. Settings now carries a hint under *API address*
  (emulator vs the computer's LAN address, and to check `<address>/health` in the phone's browser
  first), and a connection-shaped setup failure says exactly that — `Setup failed: this phone cannot
  reach <address>. 10.0.2.2 only works inside the emulator…` — instead of `failed to connect to
  /10.0.2.2:3000`. README gains a *Setting up a physical phone* section; `usesCleartextTraffic` was
  already enabled, so LAN HTTP is not the blocker.

**v0.4.10 — low-stock thresholds and alerts (item 4.9, D8).**

Server (`apps/api`):

- **Migration `0007`**: `products.reorder_point`, nullable, at or above zero, in the product's base
  units. It lives on the product because the catalogue is shared across branches (§18); `NULL`
  means "no alert configured" — every line opts in to being watched.
- **Catalogue API**: `reorderPoint` on create and update (explicit null clears, absent keeps,
  mirroring the brand/category rule), carried in `productPayload` and therefore in every
  `product.created` / `product.updated` server event — the device computes the breach from its own
  cache, offline, which is why the threshold rides the same payload as the price.
- **Import**: a `reorder_point` column (`reorder`, `reorder_at`, `low_stock`) sets thresholds in
  bulk, with the barcode carve-out — a file that never carried the column leaves stored thresholds
  alone, a blank cell in a present column clears one, and a non-number or negative value fails the
  row loudly (`INVALID_NUMBER`) instead of importing zeros. Documented in
  `catalogue-import-format.md`.
- **Demo seed**: five products carry thresholds — SKU-005 (18 on hand, point 20), SKU-013 (10,
  point 12) and SKU-018 (8, point 10) breach on a fresh seed so the Stock screen has something to
  say; SKU-004 (24, point 12) and SKU-015 (40, point 15) show the healthy-watched state.
- **Tests**: catalog-pricing gains the create/list/keep-on-absent/clear round trip and a negative
  refused with `422 VALIDATION_ERROR`; catalog-import gains the column/omitted/blank-cell trio and
  the invalid-value refusal — **163/163 across 14 suites**.

Android:

- **Room v6** (`MIGRATION_5_6`): `ProductEntity.reorderPoint`, parsed from the product list, the
  create/update response and — importantly — from `product.created` / `product.updated` events, so
  a threshold set on the server lands on an already-synced device.
- **Catalogue editor**: *Reorder point (`<unit>`)* under **Stock & status**, shown only for
  stock-tracked products, decimal keypad, blank = no alert; junk text disables Save rather than
  failing on submit. Activate/deactivate carries the threshold with it so the replacement draft
  cannot lose the watch.
- **Stock screen**: a warning banner names the breached lines ("3 products at or below the reorder
  point • Pishori rice 2kg 18 ea (point 20) • …"), and each row carries its own state pill —
  `LOW (≤ n unit)` in amber, `OUT OF STOCK` in red — computed from the same cached balances the
  rows read, so it all works with the radio off. A product with no threshold gets no pill; silence
  is absence, never a green tick.

**v0.4.11 — price lists, scheduled prices and price-change history (item 4.11, D5).**

Server (`apps/api`):

- **Migration `0008`**: `product_price_overrides` (dated, `branch_id` null = tenant-wide list,
  otherwise that shelf only; `valid_from` inclusive, `valid_to` exclusive, null = open-ended) and
  `products.price_version`, which moves only when the base price amount does — a description typo
  cannot make a device's snapshotted price look stale.
- **Resolution** (`PricingService.resolvePrice`, now branch-aware): the override in force wins by
  most specific scope, then latest window, and promotions figure on that effective list price.
  `GET /v1/pricing/resolve` takes `branchId` and reports the source (`list | override |
  promotion`).
- **Price lists API**: `GET/POST/PATCH/DELETE /v1/pricing/overrides` (`catalog.manage`), and
  `GET /v1/pricing/history` reads the new append-only `price_change_history` — every write
  (create, `edit`, `import`, `override`, `override_removed`) lands in the SAME transaction as the
  change itself, with the actor recorded.
- **Product payload**: `price_version` and the whole `price_overrides` set ride every product pull
  and event, exactly like barcodes and pack sizes — so a device computes the effective price for
  its own shelf and the current minute offline, and a scheduled flip needs no push at all.
- **Stale prices are flagged, not fixed**: sale posting now re-resolves each line for the sale's
  BRANCH at the sale's own timestamp, and any charged/policy amount mismatch — promotion,
  scheduled flip, branch row, or plain base move — produces a `STALE_PRICE_SNAPSHOT` warning.
  The receipt is never silently re-priced; a stale edit is still a 409.
- **Tests**: new `price-overrides.spec.ts` (8 tests: branch vs base, window edge at the second,
  branch beats tenant-wide, version only on the price, import history, the override lifecycle
  with removal history, the stale-price warning on a real sale, and every refusal) —
  **171/171 across 15 suites**.

Android:

- **Room v7** (`MIGRATION_6_7`): `ProductPriceOverrideEntity` + `ProductEntity.priceVersion`,
  replaced as SETs from the product list, the save response and product events.
- **Catalogue editor — *Price lists* section**: the rows (price · shelf · window words) with
  delete, an add form (All branches or a cached branch, price, `yyyy-MM-dd` start, optional end),
  a **today-preview computed by `Pricing.effectiveListPrice`** — the very function the till will
  call ("Today at West Kiosk: 330.00 — base price 320.00") — and the latest **price history**
  entries (`65.00 → 70.00 · edit · by Owner · 21 Oct 2026`).
- After any list write the editor re-pulls the list, so what the till would price from is never a
  screen that disagrees with the server.

## Verification

- `npm run verify` (fixtures + API tests): **74/74** domain-fixture checks (pricing, money parsing and
  the unit-conversion vectors) and **171/171 API tests** across 15 suites — auth, catalog-import
  **(+2: thresholds set/kept/cleared through the column, invalid value refused)**, catalog-pricing
  **(13: catalogue exports, optimistic-concurrency create/update, barcodes, tax category, auto-SKU
  generation ×3, explicit duplicate refused, blank edit keeps the SKU, low-stock threshold round
  trip + negative refused, promotions)**, **price-overrides (8: branch override vs base, scheduled
  window edge, branch beats tenant-wide, price-only versioning, import history, override lifecycle
  incl. removal history, stale-price warning on a real sale, refusals incl. cashier `403`)**,
  inventory, licensing, opening-stock-import, sync-sale, units-conversions, **transfers (18: both
  halves end to end, the conservation and cost claims, every refusal, branch scoping, numbering,
  idempotent replay)**, **stocktake (11: reason + actor movements, silent agreement, FIFO loss on a
  zero count, pack vs base variances, refused non-numbers, unknown lines, replay, `FORBIDDEN`,
  uncosted review with a durable conflict case)**, plus the `product-import`,
  `opening-stock-import`, `unit-conversion` and `domain-fixtures` unit suites — against Docker
  Postgres.
- `tsc -p tsconfig.build.json --noEmit`: clean.
- `seed:dev` run twice against a freshly migrated database: **20 products / 18 barcodes / 9 units /
  3 brands / 4 pack conversions / 18 opening movements / 2 branches / 2 price lists** both times —
  the demo catalogue is still idempotent, and the suites above run against it.
- Docker APK build across **14** Gradle modules: clean, **zero Kotlin warnings**. Verified with a full
  `clean assembleDebug` run under `--no-build-cache`, so every module's Kotlin compile actually
  executed — a build-cache hit replays no output and would have hidden any warning.
- APK signature verified with `apksigner verify --print-certs` (internal-test identity, see table).

## Known limitations (phase-scoped)

- Signed with an **internal-test** key (not a store key); fine for owner testing, not for distribution.
- Receipts are touch-entry only; camera barcode scanning shipped as 5.1, receipt rendering / ESC-POS
  adapters remain Phase 5.10.
- No shift/session screen yet (Phase 6); `cashSessionId` is nullable.
- Adjustments support a single line per command in the UI (the server accepts multi-line).
- **Variants and supplier product codes are not built** (deferred rows D4d and D4c): a barcode resolves
  to exactly one product, and pack conversion is available but **quantity/unit entry on the till** is
  still Phase 5.3 — today the stock adjust dialog, the transfer send/count screens and the stocktake
  sheet convert units.
- **Transfers are branch-to-branch documents on a till, not a network view** (ADR 0008 item 5): the
  consolidated all-branch list, and the branch-creation UI that would give a real shop its second
  shelf, both belong to later phases — the demo seed ships a second, empty branch (West Kiosk) so the
  flow can be tested from one phone by re-entering the branch id in Settings.
- **Costing is FIFO with valuation layers** (ADR 0009); full stocktake reconciliation and approvals
  (`approved_by` is populated by the negative-adjustment override flow) land with stocktake (4.8) and
  cash/shift approvals (Phase 6).
- Module build files are currently explicit per module; convention plugins are a possible
  consolidation if the configuration phase becomes a bottleneck (ADR 0007).

## Phone test checklist (owner runs on a physical Android device)

| # | Test | Pass/fail |
|---|---|---|
| 1 | Uninstall the Phase 3 build, install this one, launch (no startup crash) | ☐ |
| 1b | From Phase 4 onward: install a later build **over** this one and confirm local data is kept | ☐ |
| 1c | The app appears in the launcher with its **own icon** (teal receipt), not the Android robot | ☐ |
| 1d | Bottom bar shows five tabs (Home · POS · Stock · Sync · Setup); Catalogue and License open from Setup and the bar keeps Setup highlighted | ☐ |
| 2 | Catalogue: **Refresh from server** → product list shows real prices | ☐ |
| 3 | Stock tab: **Refresh balances** → seeded on-hand appears | ☐ |
| 4 | Stock tab: apply `-2` with reason `shrinkage` → "Queued … waiting to sync"; an empty reason is refused | ☐ |
| 5 | Airplane mode: adjustment persists after force-close/reopen; Sync shows it pending | ☐ |
| 6 | Reconnect → **Sync now** → adjustment accepted; server balance reflects it | ☐ |
| 7 | As `cashier@kiosk.test`, an adjustment is **rejected** server-side (`FORBIDDEN`) | ☐ |
| 8 | Server-side catalogue edit appears on the device after a sync (delta applied) | ☐ |
| 9 | Home shows **Accepted by the server** and **Waiting to upload** as two separate figures, each labelled | ☐ |
| 10 | With a queued sale and no network: Sync reads "Offline · N waiting", and **Connection** reads "No connection to the server" as a *separate* row | ☐ |
| 11 | Till: step a cart line up and down, remove a line, **Clear** asks for confirmation, total stays visible throughout | ☐ |
| 12 | Till: a deactivated product is absent from the list and refused with a message if scanned/added | ☐ |
| 13 | Stock: the adjust dialog shows *current → after this change*; going below zero shows the supervisor-override warning | ☐ |
| 14 | Setup: password is masked, **Enrol this device** stays disabled until every field is filled | ☐ |
| 15 | Catalogue: search + All/Active/Inactive filter, and a product edit shows the six labelled sections | ☐ |
| 16 | Every icon-only control announces a content description (TalkBack reads "Back", "Clear search", "Add … to the cart") | ☐ |
| 17 | Fresh install → Setup → **Enrol**: the product list appears **without** opening the catalogue first, and scanning `6001000000032` adds Sugar 1kg with a banner naming the item, the cart count and the running total | ☐ |
| 18 | Home → **Products** opens the catalogue in one tap and shows all 20 seeded products across 5 categories | ☐ |
| 19 | Till: **Scan a barcode** sits above the search box on both *Find items* and *Cart*; `6001000000087` and `6001000000216` both add Soda 300ml; an unknown code says what to do next; the deactivated Dishwashing liquid never appears in the list | ☐ |
| 20 | Stock → **Opening stock**: type `SKU-010,5` → the preview shows *on hand 0 → 5* and a **Ready** pill; **Import 1 line(s)** → the Stock list shows 5 for Orange juice | ☐ |
| 21 | Stock → **Opening stock**: a line naming `SKU-999` produces a red problem report and the import button stays disabled, and re-opening the screen starts clean | ☐ |
| 22 | Catalogue → product editor → **Pack sizes**: `Soda 300ml` shows `1 crate = 24 ea`; adding `pallet` is refused with *there is no unit "pallet"* (add `bundle` under Manage first and it is accepted); removing a pack removes it from Stock → Adjust after a sync | ☐ |
| 23 | Stock → adjust `Soda 300ml`: choose **crate**, type `2` → preview reads `2 crate = 48 ea` and `→ 48 ea on hand after this is queued`; queue it, sync, then the movement history reads `2 crate → +48 ea` | ☐ |
| 24 | Stock → adjust `Tomatoes` in `g`: `125 g` converts to `0.125 kg` and syncs; a whole-number `crate` count that lands on a fraction (e.g. `1.3 crate`) is blocked with the reason instead of being queued | ☐ |
| 25 | Catalogue → **Manage**: add unit `bundle` (kind count) and brand `Test Brand`, then create a product picking both from the lists; `GET /v1/config/snapshot` carries them | ☐ |
| 26 | Stock → **Cross-branch transfers**: pills read `Sent from here (0)` / `Coming here (0)`, the in-transit info banner explains where goods are counted, and **Send stock to another branch** is offered; opening it shows **West Kiosk** as the only destination | ☐ |
| 27 | Send stock → West Kiosk, scan `6001000000087` (Soda 300ml), choose **crate** and type `2` → preview `2 crate = 48 ea` with *on hand 48, left 0* → dispatch while offline: the card says **Queued — pending on this device** with *queued on this device* instead of a number, Stock's *In transit from this branch* names it, and Soda's on-hand reads 0 | ☐ |
| 28 | Reconnect → **Sync now**: the same card now reads `TRF-0001` and **Last synced …**; the document is under *Sent from here* and the server's `GET /v1/inventory/transfers?branchId=…` returns it with `inTransitQuantity: 48` | ☐ |
| 29 | Send 1 more crate of Soda: because Main now holds 0, the **supervisor note becomes required** (button disabled until filled, banner says why); dispatch with the note → after sync the card reads **Needs attention — NEGATIVE_STOCK** with the server's sentence, while the goods never move twice | ☐ |
| 30 | Settings → Branch id `22222222-2222-4222-8222-222222222223` → **Set up** (do this after syncing: a command queued at Main and pushed from a West-enrolled device must come back **Needs attention — BRANCH_MISMATCH**, never vanish) → the document moves to *Coming here* as **Waiting for your count** → **Count what arrived**, change 48 → 46 (a shortage raises the required note), try 50 (refused in place: *a surplus belongs on a supplier receipt*), queue with the note → after sync the card reads **Arrived short**, the line `counted 46 — 2 short` | ☐ |
| 31 | After the receipt: West Kiosk's Stock shows the 46 it counted, Main's still shows 0 (the 48 it sent is in neither shelf until counted), Main's in-transit list is empty again, and switching Settings back to Main restores Main's view | ☐ |
| 32 | Stock → **Stocktake**: the info banner says the count goes up as what you READ, never as a plus or minus; *Count everything with stock (n)* prefills a sheet of only what this branch holds **above zero** (Soda, standing at 0 at Main since row 31, is NOT among them); every card shows the product, its **book** and an empty field reading *Not counted yet — a blank line is left out of the count* | ☐ |
| 33 | Scan `6001000000087` (Soda) → its line appears with book `0 ea`; type `0` → *Agrees with the book — writes nothing*; type `1` → *1 ea found*; tap the **crate** pill → `1 crate = 24 ea` and the words become `24 ea found`; type `-3` into a line → *a count cannot be below zero* in place, the field goes red, and the queue button counts only the valid lines | ☐ |
| 34 | Fill two sheet lines with their shown **book** (both read *Agrees with the book — writes nothing*), set a third line to `0` (*N <unit> short of the book*), add note `Sunday night count` → **Queue count (n line(s), 1 differ)** → the card says **Queued — pending on this device**; airplane mode before queueing to prove it needs no network | ☐ |
| 35 | **Sync now** → the count lands: the zeroed product's on-hand is 0, its movement history shows a **Stock count** row with the negative quantity and **by Owner**, the book-agreeing products have NO new movement at all, and `GET /v1/inventory/movements?productId=…` returns `actor_id`/`actor_name` for every row | ☐ |
| 36 | Physical phone: Settings → API address shows the emulator hint; leave `10.0.2.2` and **Set up** → the failure now reads *this phone cannot reach … 10.0.2.2 only works inside the emulator…*; set the computer's LAN address (`http://<LAN ip>:3000/v1`), open `<address>/health` in the phone's browser first (JSON), then **Set up** succeeds and pulls the catalogue | ☐ |
| 37 | Catalogue: scan a barcode **not in the catalogue** (e.g. `6099999999991`) → *Nothing here has barcode …* with **Create product with this barcode** → the editor opens with the barcode already listed and SKU blank (`blank = auto-generate`) → enter name + price → **Save** → toast `… saved as SKU-021`, and the new product appears in the list with its barcode | ☐ |
| 38 | Catalogue: scan a barcode that **is** in the catalogue → its product opens as before; in an existing product's editor, type a code into *Add barcode* and press the scanner's Enter → the barcode is added without touching **Add**; clear an existing product's SKU and save → the SKU is **unchanged** (blank keeps it), while a fresh product's save message shows the generated number | ☐ |
| 39 | Stock tab (fresh seed, Main branch): a warning banner reads *3 products at or below the reorder point* naming Pishori rice 2kg (18 ea, point 20), Eggs tray (30) (10 ea, point 12) and Shampoo 400ml (8 ea, point 10); those rows carry a `LOW (≤ …)` pill and Sunflower oil / Bar soap carry none | ☐ |
| 40 | Catalogue: open Pishori rice 2kg → *Reorder point (ea)* shows `20`; change it to `5` and save → the Stock banner and the row's pill are gone (18 > 5); set it back to `20` → the pill returns after **Refresh from server** (or immediately in the cached view) | ☐ |
| 41 | Catalogue: clear a product's reorder point (blank field) and save → the row shows no pill; typing junk (e.g. `abc`) disables **Save**; deactivate/reactivate a watched product → its threshold is still there afterwards | ☐ |
| 42 | Catalogue → Import: commit a CSV with a `reorder_point` column (values + one blank cell) → the thresholds land on those products; re-import the same file **without** the column → stored thresholds survive; a blank cell in a present column clears its threshold | ☐ |
| 43 | Catalogue → open **Sunflower oil 1L (SKU-004)** → *Price lists* shows the seeded row `330.00 · West Kiosk` with its window, the preview reads *Today at Main Kiosk: base price 320.00* (this device's shelf — a West row does not touch Main), and **Price history** lists the earlier price edits with actor and date | ☐ |
| 44 | Same editor: pick **Applies to → All branches**, price `325`, *From* `yyyy-MM-dd` (today), *Until* blank → **Add price list row** → the row appears, the preview flips to *Today: 325.00 — base price 320.00*; **Refresh from server** and reopen → still there; delete it → preview returns to 320.00 and a `list row removed` line lands in the history | ☐ |
| 45 | Catalogue → **Maize flour 2kg (SKU-006)** → a tenant-wide row `220.00` scheduled from `2030-01-01` is listed with its window and the preview stays on the base price (the window has not opened — a scheduled price must not bite early); typing junk in the *Price* or *From* field disables **Add price list row** and shows the error state | ☐ |
| 46 | Edit a product's base price and save → *Price history* gains a `… → … · edit · by Owner` line; with the radio off, the *Price lists* section and its preview still render (Room), while the history simply stays at what it last fetched | ☐ |

A failure involving lost transactions, duplicate posting, corrupted local data or a false
payment/tax status blocks the phase.
