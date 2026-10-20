# Phase 4 — APK delivery record

Required by §15 "Mandatory Android APK delivery gate". Every field below is part of the gate.

| Field | Value |
|---|---|
| **Phase** | 4 — Catalogue, pricing/promotions and inventory (+ post-phase polish) |
| **App version** | `0.4.6` (versionCode 406) |
| **Artifact** | `artifacts/retail-erp-p04-v0.4.6.apk` |
| **SHA-256** | `d75d408280de6bed4a9f44c495323584abfbfc28b096a5fbb5fa064d1b3fa3c6` |
| **Size** | ~40.2 MB (bundled ML Kit barcode models, unminified debug build) |
| **Signing** | **Stable internal-test key** (`CN=Kiosk ERP Internal Test`, cert SHA-256 `935c0fbc6993db9ca761b4c3610c71a50d91897fd9b1753d0da3e56dffd056dd`), generated once by `build-apk.sh` and git-ignored (ADR 0005) |
| **Build** | Docker image `kiosk-erp-android-builder` (JDK 17 + Android SDK 34 + Gradle 8.7); `PHASE=04 VERSION=0.4.6 bash infra/docker/android/build-apk.sh` |
| **Expected backend** | `apps/api` on `http://<host>:3000/v1` with migration `0005`; seed tenant/branch from `seed-dev.ts` (20-product demo catalogue with 9 units, 3 brands and 4 pack sizes — see `demo-catalogue.md`) |

**Build history inside Phase 4** (each is signed with the same stable key, so each upgrades in place):

| Version | versionCode | SHA-256 (first 16) | What it added |
|---|---|---|---|
| `0.4.1` | 401 | `74caefeab641af20` | Catalogue management UI, dated promotions, inventory movements, multi-module split, launcher icon |
| `0.4.2` | 402 | `65580399f57da74e` | Offline camera scanner (5.1), FIFO valuation (ADR 0009), barcode editing, catalogue import file picker, per-product movement history |
| `0.4.3` | 403 | `cb6bbe8d363fa843` | UI usability pass: `:core:designsystem`, redesigned Home / Till / Stock / Sync / Setup / Catalogue / Licence |
| `0.4.4` | 404 | `9e45a6a88b151008` | Scan-to-add made reliable (catalogue pulls itself on enrol/sync, paged fetch), scanner-first till, Products row on Home, 20-product demo catalogue |
| `0.4.5` | 405 | `804f15d75709a7c8` | Opening-stock import (4.5): `POST /v1/inventory/opening-stock/import` + Stock → Opening stock screen (file picker or typed lines) |
| `0.4.6` | 406 | `d75d408280de6bed` | Units of measure + pack sizes + brands (4.6): conversion at every ledger write, pack picker in the adjust dialog, Manage gains Units & Brands |

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

## Verification

- `npm run verify` (fixtures + API tests): **74/74** domain-fixture checks (pricing, money parsing and
  the unit-conversion vectors) and **127/127 API tests** across 12 suites — auth, catalog-import,
  catalog-pricing, inventory, licensing, opening-stock-import, sync-sale, units-conversions, plus the
  `product-import`, `opening-stock-import`, `unit-conversion` and `domain-fixtures` unit suites —
  against Docker Postgres.
- `tsc -p tsconfig.build.json --noEmit`: clean.
- `seed:dev` run twice against a freshly migrated database: **20 products / 18 barcodes / 9 units /
  3 brands / 4 pack conversions / 18 opening movements** both times — the demo catalogue is still
  idempotent, and the suites above run against it.
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
  still Phase 5.3 — today only the stock adjust dialog converts units.
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

A failure involving lost transactions, duplicate posting, corrupted local data or a false
payment/tax status blocks the phase.
