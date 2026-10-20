# Master delivery plan

**Source of truth:** `offline_first_retail_erp_architecture.md` (v1.2, 18 Oct 2026), held at the
workspace root. Phase names, gates and acceptance criteria below are taken from §15 and §16 of that
document; nothing here is invented to replace it.

**Phase gate rule (§15.1).** A phase is *not* finished because screens exist. It is finished when data
persists, rules are tested, the backend accepts it correctly, failures are recoverable, and the phase's
APK passes the physical-phone check. Every phase 0–12 ships an installable, internally-signed APK plus a
`docs/operations/phase-NN-apk-record.md`. Grading is per phase, and no phase starts before the previous
one is accepted.

**Working rule for this repository (owner instruction).** Build each phase out fully — not a demo
skeleton — before moving on. Where an item genuinely belongs to a later phase it is *skipped here and
recorded in the deferred-items ledger below*, then completed when that phase is reached. Nothing is
quietly dropped.

---

## 1. Current-state audit

Status key: ✅ present · 🟡 partial · ❌ absent.

| Phase | Theme | Status | Summary |
|---|---|---|---|
| 0 | Discovery, workflow mapping, compliance | 🟡 | `docs/product/phase-0-discovery.md` written; owner sign-off and the §18 decision register are outstanding |
| 1 | Domain contracts, data model, sync spec | 🟡 | Fixtures, sync protocol, posting matrix, ADRs, UoM/pack-size contract (`units-and-conversions.md`) exist; **no OpenAPI skeleton, no ERD, no state machines beyond `Sale`, no event-version policy** |
| 2 | Backend foundation and cloud controls | 🟡 | NestJS + Postgres + auth/RBAC + devices + licensing + outbox work; **no CI, no staging deploy, no backups/restore drill, no OpenAPI generation, no rate limits, `LicenseBillingModule` absent** |
| 3 | Native shell, local DB, sync center | 🟡 | Shell, Room, push/pull, Sync Center, enrolment work; **`LicenseManager` request export (`.licreq`/QR), entitlement display, Keystore installation key, replay/rollback detection, app lock/offline expiry absent** |
| 4 | Catalogue, pricing, inventory ledger | 🟡 | Products/barcodes/tax/categories/promotions + movement ledger + balances work; product CRUD UI, category/units/brands/tax management, bulk import, opening-stock import and movement history UI all in; units + pack conversions + brands now hold one base-unit ledger; cross-branch transfers (dispatch/receipt/discrepancy) now move goods under one document; **no price lists/scheduled prices, no stocktake, no low-stock thresholds, no variants, no supplier product codes** |
| 5 | Offline POS vertical slice | 🟡 | Search, scan, cart, offline cash sale, outbox, idempotent posting work; **no cashier session/role gate, no discounts UI, no price override, no customer on sale, no split tender, no hold/resume, no void, no receipt rendering/printing, no sales-history screen** |
| 6 | Cash, shifts, refunds, end-of-day | ❌ | `cash_sessions`/`cash_movements` tables only; no float, count, variance, approval, shift close, returns/refunds/exchange |
| 7 | Customers, suppliers, debtors, creditors | ❌ | `customers`/`suppliers`/`customer_ledger_entries` tables only; no modules, no UI, no credit policy |
| 8 | General ledger and core reports | ❌ | `chart_of_accounts`/`journals`/`journal_lines` tables + draft posting matrix only; no posting rules wired, no reports |
| 9 | Owner dashboard, multi-device | 🟡 | Local dashboard tiles + sync state; **no KPIs, no exception centre, no realtime channel, no device health view, no standardised freshness labels** |
| 10 | eTIMS, M-PESA, provider adapters | ❌ | Nothing; receipt status labels exist only as concepts |
| 11 | Security hardening, performance, pilot | ❌ | Keystore licence verification only; no local DB encryption, no threat model, no scans, no load tests, no pilot |
| 12 | Android release, monitoring, expansion | ❌ | Nothing; no AAB, no privacy disclosures, no rollout plan |
| 13 | Native iOS client | ❌ | `apps/ios/KioskERP/Core/Domain/Pricing.swift` parity port only, by design |

### Repository structure vs §14

Present: `apps/{android,api,ios}`, `packages/{api-contract,domain-fixtures,integration-contracts}`,
`infra/docker`, `docs/{architecture,product,accounting,operations}`, `tests/`.
Absent: `infra/{migrations,deploy,observability}`, `docs/compliance`, `tests/{contract,sync-scenarios,acceptance}`
(a `tests/README.md` exists), and `packages/api-contract` holds only a README — **the OpenAPI document
itself does not exist yet.**

---

## 2. Architecture conformance ledger

### Branch edge gateway (new MVP component, ADR 0010)

The owner's §18 answers (multiple branches, multiple offline tills, total isolation) make the branch
edge gateway **launch-critical**, so §17's "keep it out of MVP" no longer applies. It is a separately
tested deliverable:

| Area | Deliverable | Target phase |
|---|---|---|
| Identity | Gateway enrolment + trust record (gateway ↔ cloud, till ↔ gateway) | 2–3 |
| Local ledger | Branch-authoritative stock/sales ledger + durable storage + backups | 5–6 |
| Till protocol | Till ↔ gateway command submission and status; degraded-mode rules | 5–6 |
| Cloud sync | Gateway ⇄ cloud push/pull, independent of any till | 6 |
| Ops | Install, upgrade, backup, restore and recovery runbook | 11 |
| Acceptance | Gateway suite: WAN loss, reboot mid-sale, gateway loss, recovery, reconciliation | 11 |

### §5 Android module map

| §5 module | Actual | Action |
|---|---|---|
| `app` | `:app` | ✅ conforms |
| `core:database` | `:core:database` | ✅ |
| `core:domain` | `:core:common` | **Rename/absorb**: `core:common` already holds pure values (`Pricing`, `UiTime`) — align the name and give it the use cases |
| `core:network` | `:core:network` | ✅ |
| `core:sync` | inside `:core:data` (`SyncEngine`) | **Extract `:core:sync`** so outbox/push/pull/conflict handling is its own boundary |
| `core:security` | `:core:security` | ✅ |
| `core:device` | absent (scanning lives in `feature:pos`) | **Create `:core:device`**: camera scanning, printer adapter, share/export |
| `core:designsystem` | `:core:designsystem` | ✅ created (UI usability pass): `Tone` + shared state components (banner, status pill, empty/error/loading, stat tile, detail/nav rows) and the app typography scale |
| `feature:pos` | ✅ | Keep and complete |
| `feature:catalog` | ✅ | Keep and complete |
| `feature:inventory` | ✅ | Keep and complete |
| `feature:customers` | ❌ | Phase 7 |
| `feature:suppliers` | ❌ | Phase 7 |
| `feature:receivables` | ❌ | Phase 7 |
| `feature:payables` | ❌ | Phase 7 |
| `feature:cash` | ❌ | Phase 6 |
| `feature:reports` | ❌ | Phase 8 |
| `feature:settings` | ✅ | Keep |
| `feature:sync-center` | `:feature:sync` | Rename for clarity (Phase 3 tidy-up) |
| — | `:feature:dashboard` (owner dashboard, §3.I) | Keep; §5 does not forbid it |
| — | `:feature:license` (§14 requires a native licensing feature) | Keep; required by §14 |

ADRs 0007 must be amended to record the final graph once these moves land.

### §9 NestJS module map

Present: `auth`, `catalog`, `pricing`, `inventory`, `sales`, `sync`, `devices`, `licensing`, `platform`, `health`.
Still to add, in phase order: `CashManagementModule` (6), `CustomerModule` + `ReceivableModule` +
`SupplierModule` + `PurchasingModule` + `PayableModule` + `PaymentsModule` (7), `AccountingModule` +
`ReportingModule` (8), `ETIMSModule` + `MPesaModule` (10), `LicenseBillingModule` + `LicensePackageModule`
(2 residual), `NotificationModule`, `AuditModule`, `FilesModule` (as needed by the phase that needs them).

---

## 3. Deferred-items ledger

Items deliberately **not** built in an earlier phase because the architecture assigns them later. Each
must be completed when its target phase is reached.

| # | Item skipped | Appears in | Target phase | Done |
|---|---|---|---|---|
| D1 | Product/category/tax **management UI** (server CRUD exists) | §3.C, §15 Ph4 | 4 ✔ | ✔ |
| D2 | Bulk product import with preview/validation/error report (`POST /v1/products/import`) | §9, §15 Ph4 | 4 | ✔ |
| D3 | Opening-stock import workflow (seeded opening stock with FIFO layers exists) | §15 Ph4 | 4 | ◐ |
| D4 | Units of measure + conversions, variants, brands, supplier product codes — **split below into D4a–D4d** (owner decision: 4.6 = units + brands only) | §3.C | 4 | ◐ |
| D4a | Units of measure + product pack conversions (`units_of_measure`, `unit_conversions`) | §3.C | 4 | ✔ |
| D4b | Brands (`brands`, `products.brand_id`) | §3.C | 4 | ✔ |
| D4c | Supplier product codes on the catalogue — needs the Supplier module, so it lands with it | §3.C | 7 | ☐ |
| D4d | Product **variants** (size/flavour/colour as distinct sellable items) — needs its own exit criterion agreed **before Phase 5 starts**, because variants change what the till resolves a barcode to | §3.C | 4 (before Ph5) | ☐ |
| D5 | Price lists, branch/customer/scheduled prices, price-change history | §3.C | 4 | ☐ |
| D6 | Stock transfers with dispatch/receipt states | §3.D, §15 Ph4 | 4 ✔ | ✔ |
| D7 | Stocktake / cycle count | §3.D, §15 Ph4 | 4 | ☐ |
| D7a | Stock valuation is **FIFO with valuation layers** (ADR 0009), replacing weighted average | §7, §18.5 | 4 ✔ | ✔ |
| D7b | Till blocks a sale that would take stock negative; `UNCOSTED_STOCK` resolution path | §18.5 | 5 | ☐ |
| D7c | Branch edge gateway (ADR 0010) — new MVP component | §6, §17 | 5–11 | ☐ |
| D8 | Low-stock/reorder thresholds + alerts | §3.D | 4 | ☐ |
| D9 | Editing barcodes on an existing product (`PATCH /v1/products/:id`) | §3.C | 4 ✔ | ✔ |
| D10 | Cashier session + role gate on the till | §15 Ph5 | 5 | ☐ |
| D11 | Discounts (line/order), price override with permission, customer on sale, notes | §3.B, §15 Ph5 | 5 | ☐ |
| D12 | Held/resumed sales and void-before-finalisation | §15 Ph5 | 5 | ☐ |
| D13 | Receipt rendering + printing adapter, local receipt state labels | §15 Ph5 | 5 | ☐ |
| D14 | Sales history with per-sale sync status | §15 Ph5 | 5 | ☐ |
| D15 | Split/multiple tender methods and their statuses | §3.B | 5 (cash) → 7 (credit) → 10 (M-PESA) | ☐ |
| D16 | Refunds, returns, exchange flows (**Phase 6, not 5** — corrected against §15) | §15 Ph6 | 6 | ☐ |
| D17 | Shift close, expected-vs-counted, variance, supervisor approval | §15 Ph6 | 6 | ☐ |
| D18 | Customer/supplier master, credit policy, statements, aging | §15 Ph7 | 7 | ☐ |
| D19 | Purchase orders, GRNs, supplier bills, AP | §15 Ph7 | 7 | ☐ |
| D20 | Journal posting for every business event; trial balance, P&L, balance sheet, stock valuation | §15 Ph8 | 8 | ☐ |
| D21 | Realtime owner channel (SSE/WebSocket) + freshness labels | §12, §15 Ph9 | 9 | ☐ |
| D22 | eTIMS adapter and receipt-tax states | §11, §15 Ph10 | 10 | ☐ |
| D23 | M-PESA initiation + idempotent callbacks | §11, §15 Ph10 | 10 | ☐ |
| D24 | Local database encryption at rest | §10 | 11 | ☐ |
| D25 | CI, staging deploy, backups + restore drill, rate limits | §15 Ph2 | 2 residual | ☐ |
| D26 | OpenAPI document + generated client metadata | §9, §15 Ph1 | 1 residual | ☐ |
| D27 | *(split below)* Adopt the §5 module reorganisation | §5 | 3 residual | ◐ |
| D27a | `:core:designsystem` — shared offline/empty/error/loading state components + typography, so every screen speaks the same language | §5 | done early (needed by the UI pass) | ✔ |
| D27b | Adopt `:core:domain`, `:core:sync`, `:core:device` module split (the rest of D27) | §5 | 3 residual | ☐ |
| D28 | `LicenseManager`: renewal request export (`.licreq`/QR), entitlement display, Keystore installation key, replay/rollback detection | §13.4, §15 Ph3 | 3 residual | ☐ |
| D29 | Licence lifecycle pilot (duplicate/replay rejection, device transfer, maintenance expiry without core shutdown) | §15 Ph12 | 12 | ☐ |

---

## 4. Phase plans

Granular detail is given for the phases being built now (4, 5, 6) and progressively lighter further out;
each later phase is expanded to the same granularity as it becomes current.

### Phase 4 — Catalogue, pricing and inventory ledger (closing out)

| # | Item | Exit criterion |
|---|---|---|
| 4.0 ✔ | **FIFO valuation layers** (ADR 0009, replaces weighted average) | Done: layers + cost allocations + `cogs_minor`, `GET /v1/inventory/valuation`, override rule for negative adjustments, seeded opening stock. 29/29 API tests pass |
| 4.1 ✔ | `PATCH /v1/products/:id` accepts `barcodes`; device replaces that product's barcodes transactionally (D9) | Done: set semantics, `DUPLICATE_BARCODE` conflict, barcode resolves immediately after the change |
| 4.2 ✔ | Product management UI: list/search, create, edit, deactivate; barcodes, category, tax category, unit, cost, price | Done: `feature:catalog` list + editor + barcode set editing; Room v3 adds description/category/taxCategory/active |
| 4.3 ✔ | Category + tax-category management UI | Done: "Categories & tax" screen in `feature:catalog`; rate entered as a percentage, stored exactly in basis points |
| 4.4 ✔ | Bulk import: CSV/JSON upload → **preview → validation → per-row error report → commit** (D2) | Done: `POST /v1/products/import` (preview/commit share one planner, all-or-nothing) + device file picker with the server-validated preview; 18 unit + 8 endpoint tests |
| 4.5 ✔ | Opening stock import (D3) | Done: `POST /v1/inventory/opening-stock/import` — preview/commit share one pure planner, all-or-nothing, report carries `onHandBefore/After` + three warnings; commit appends `opening_stock` movements that open FIFO layers; `requestId` makes a retried commit idempotent; Stock tab gains an Opening stock screen (file picker or typed lines); 16 unit + 11 endpoint tests |
| 4.6 ✔ | Units of measure + pack conversions + brands (D4a, D4b) | Done: `units_of_measure` (`kind` = count/weight/volume — the rule, not a label), product-scoped `unit_conversions` as a SET (factor = base units per 1 of the pack), `brands` + `products.brand_id`; `InventoryService.resolveQuantity` is the single conversion point, so a movement is always recorded in `products.unit` and remembers `entered_unit`/`entered_quantity`; receipts, adjustments and opening import all convert, quoted costs divide to cost-per-base, overrides are measured in base; `unit_kind` rides the product payload so a device converts offline; device: Room v4 (brand, conversions, unitKind), product editor pack sizes + brand + unit picker, Manage gains Units & Brands, stock adjust dialog picks a pack and previews `10 crate = 240 ea` with the server's own reference implementation, history shows `10 crate → +240 ea`; 74/74 fixtures + 127/127 API tests; `units-and-conversions.md` |
| 4.7 ✔ | Cross-branch stock transfers with dispatch/receipt/discrepancy states (D6, ADR 0008) | Done: stock is in exactly one branch or in transit, never both — `stock_transfers` + `stock_transfer_lines` (one document, two per-branch steps, `from <> to` and status↔`received_at` by CHECK, `UNIQUE (tenant, reference)`); dispatch consumes the source's FIFO layers (`costMode: 'transfer'` — allocations, no COGS) and stamps a carried cost per base unit on each line, the receipt opens the destination's layer at that same cost; in transit belongs to **neither** branch; shortages stay on the document as `discrepancy` and need a supervisor note, over-receipt refused; `TRF-0001` from a tenant-wide series; `inventory.transfer` + branch-scoped list (ADR 0008 item 5, pushOne `BRANCH_MISMATCH`); device: Room v5 (transfers + lines + branches), outbox `StockTransfer` commands, direction pills, send/count screens, in-transit under Stock rows; 74/74 fixtures + 145/145 API tests; `stock-transfers.md` |
| 4.8 | Stocktake / cycle count (D7) | A count produces adjustment movements with reason and actor |
| 4.9 | Low-stock thresholds and alerts (D8) | Threshold breach is visible on the Stock screen |
| 4.10 ✔ | Movement history UI per product/location (D8) | Done: per-product history in the Stock tab (source, signed quantity, reason, date, COGS); reads the server ledger |
| 4.11 | Price lists / branch prices / scheduled prices + price-change history (D5) | A price change is versioned; a stale device price is flagged, never silently overwritten |

#### UI usability pass (v0.4.3, between 4.4 and 4.5)

Owner request before continuing: *make the UI user friendly*. Not a phase item — an overhaul of what
had been built so far, done inside the phase-4 APK so the rest of the plan is built on screens worth
using.

- **New `:core:designsystem` (D27a).** One vocabulary for the state every screen has to express:
  `Banner` (offline / saved / failed, with an optional action), `Pill` (status word + tone),
  `EmptyState`, `ErrorState` with retry, `LoadingState`, `StatTile`, `DetailRow`, `NavRow`, `SectionTitle`,
  `ScreenHeader`. Tones are theme-aware so a status chip stays readable in sunlight *and* at night, and
  every tinted state carries its meaning in **words** — colour alone never says anything (§5).
- **Typography**: body 15sp, labels 13/15sp, titles with real weight contrast — arm's-length legibility
  without shrinking things below comfortable tap or read size.
- **Home**: §7's separation of money is now on screen — *Accepted by the server* beside *Waiting to
  upload* (provisional, labelled as such), plus a sync card whose **connection and queue are separate
  rows** (§16: a green network icon is not enough), recent sales with per-sale state pills, and an
  enrolment banner that routes to Setup when the device cannot sync yet.
- **Till**: "Test item" scaffolding buttons removed; `Find items ⇄ Cart` toggle so a 20-line basket
  still shows the total; cart lines now have quantity steppers and a remove button (the total bar
  always visible); inactive products are hidden from the till and cannot be added; scan result shown
  as a dismissible success/error banner; clearing the cart asks first; every empty state names the
  next step.
- **Stock**: leads with on-hand per product, search, and adjust behind a dialog that shows
  *current → after this change* and warns when it would go negative (server would require a
  supervisor override). Movement history restyled with source pills and costed-out losses.
- **Sync Center**: headline status word, then the two facts kept apart — *Waiting to upload* and
  *Connection* — followed by needs-attention cards that translate the conflict code into the next
  action, the waiting queue, and a **Diagnostics** section so the support-only test command is no
  longer mixed in with normal controls.
- **Setup**: sections with plain-language captions, status pill (Ready to sync / Not enrolled), the two
  opaque UUIDs moved into a labelled *Device identifiers* block, email/password keyboard types and
  password masking, disabled + progress states on enrol.
- **Catalogue**: search with clear, All/Active/Inactive filter, price right-aligned, overflow menu for
  edit/deactivate, dismissible result banners, offline banner, sectioned product editor
  (Identity / Pricing / Selling unit / Category & tax / Stock & status / Barcodes), and an import
  preview headed by a valid-or-problem pill.
- **Licence**: what each of the two crypto boxes is, verification refused until both are present, and
  the outcome reported as one word before the detail.
- **Accessibility**: content descriptions on every icon, ≥44–48dp targets on primary controls, no
  state conveyed by colour alone, error text never truncated.

Still to do when its phase arrives: cashier session and role gate (5.2), oversell block (5.2a),
weight/decimal quantity entry (5.3), sales history screen (5.11).

#### Scan-to-add + demo catalogue (v0.4.4, still between 4.4 and 4.5)

Owner request before continuing: *add scan-to-add and make sure it adds, let me view the products, and
seed a catalogue worth testing against*. Three findings came out of tracing the scan path end to end:

- **Why a scan added nothing.** `GET /v1/products` returns barcodes, `barcodes` are cached as a SET,
  and the scan resolves from Room — all correct. What was missing was a way for the catalogue to ever
  *arrive*: the sync engine applied product deltas but only refreshed the catalogue on demand, and a
  shop that already exists (including `seed-dev.ts`, which writes no `server_events`) produces no
  deltas at all. A brand-new till therefore pulled an empty feed, listed no products and answered
  every scan with "no product matches" until somebody found Setup → Catalogue → Refresh. Now:
  enrolment finishes with a first sync, and `SyncEngine` refreshes the catalogue whenever a pull
  carries a product event **or** the device has none at all. A failed refresh never fails a sync.
- **Page ceiling.** The catalogue fetch requested `limit=500` exactly once, so past 500 SKUs the
  scanner could never see a product. It now pages until the server returns a short page, with an
  explicit ceiling so it cannot spin.
- **Scanner-first and visible confirmation** (§5): a full-width *Scan a barcode* button sits ahead of
  the search box on both halves of the loop, and a successful add names the item, the cart count and
  the running total in the banner. Home gained a **Products** row so the catalogue is one tap from
  the first screen.
- **Demo catalogue** (20 products / 5 categories / 18 EAN-13 barcodes / 16 further opening movements
  + FIFO layers): a zero-rated line beside VAT 16%, an item with two tags, two with none, one with no
  stock, one not stock-tracked and one deactivated. Documented row by row in
  `docs/operations/demo-catalogue.md`; still idempotent, and the two original barcodes that the test
  suite pins are untouched.

#### Opening-stock import (v0.4.5, item 4.5)

The exit criterion is the design: **an opening balance is a movement, never an edit to a quantity.**
`POST /v1/inventory/opening-stock/import` (permission `inventory.receive`) plans the whole file with
a pure function before the transaction opens, then appends one movement per line (`reason: 'opening'`,
`source_type: 'opening_stock'`) which also opens the FIFO layer that values that stock from day one.
`stock_balances` stays a projection — the test that pins this asserts the stored quantity equals the
sum of its movements, so there is no code path in the import that writes a quantity.

- **One planner for CSV, JSON, preview and commit**, so what the operator approves is exactly what
  runs. An invalid file answers with the report and writes nothing; a preview does not even create
  the branch's stock location.
- **The preview is a before/after, not a number**: `onHandBefore → onHandAfter` per line, plus totals
  in units and shillings, and per-line unit cost and value. Three warnings inform without blocking —
  opening stock already present for that product, a cost that is unknown (so the line would be valued
  at 0), and a branch that has already traded.
- **Retries cannot double-count.** The device mints one `requestId` per file chosen; it becomes each
  movement's `source_id` and `command_id`, so a commit that times out and is retried reports
  `alreadyApplied: true` instead of opening a second lot of stock. The ledger's own unique index on
  `(tenant, command, product, source)` is the backstop if two identical commits ever race.
- **A cost stated in the file** updates `products.cost_minor` (it is only ever the latest known
  purchase cost); an omitted cost never rewrites what the buyer already recorded.
- **Screen**: Stock → *Opening stock* → choose a CSV/JSON file **or** type the lines → report →
  *Import N line(s)*. On success the balances are refetched so the Stock list shows the new on-hand,
  and a replayed commit says *already imported* rather than *imported*.
- Documented in `docs/operations/opening-stock-import.md`; 16 planner unit tests + 11 endpoint tests.

#### Units, pack sizes and brands (v0.4.6, item 4.6)

The exit criterion is one sentence: **a shop buys in crates and sells in pieces without splitting
its stock book.** Stock is held in exactly one unit per product (`products.unit`); every other unit a
quantity may be *written* in is a conversion **into** it, and `1 crate = 24` is a fact about soda (12
for water), so pack sizes are product-scoped rows, not unit rows.

- **`kind` is the rule, not a label.** `count` means a converted quantity must come out whole —
  `1.3` crates of 24 is `31.2` bottles, and that is refused rather than rounded — while `weight` and
  `volume` accept fractions because a scale does not care. Factors are always relative to the base
  unit and must be finite and greater than zero; a pack may not convert a unit into itself.
- **One conversion point.** `InventoryService.resolveQuantity` resolves a quantity before anything is
  written, and `applyMovement` is the single write path behind it, so there is no code path that can
  record stock in a unit other than the product's. A movement that *was* converted remembers
  `entered_unit` / `entered_quantity` (paired nulls by CHECK); one written in the base unit carries no
  phantom pair. Receipts and adjustments resolve every line first, so one unknown pack refuses the
  whole command with nothing received, and a supervisor override is measured against the **base**
  quantity — 48 bottles, not 4 crates.
- **Costs divide, stock costs never do.** A quoted `unitCostMinor` is per the unit on the paperwork and
  is divided by the factor into cost-per-base before it opens a FIFO layer or updates
  `products.cost_minor`; `10 crate @ 24000` therefore opens one layer at 24,000 a bottle.
- **The base-unit rule, and no invented rules.** A quantity typed in the product's own unit is held to
  the same rule (`0.5 ea` refused), which the opening-stock planner mirrors so a preview never accepts
  what its commit then refuses. Where a unit's kind is unknown the ledger reports `unit_kind: null`
  and applies **no** rule — falling back to `count` would refuse a legal weigh for a product whose unit
  nobody had added to the vocabulary, with a message about whole kilos.
- **Configuration, not events.** Units and brands are CRUD endpoints plus `units`/`brands` on the
  config snapshot; they ride on the product payload (`brand_id`, `brand_name`, `unit_kind`,
  `conversions[]`) rather than as server events, because they travel with the product that needs them
  and a device must be able to convert offline on the same pull that brings the factors (§6).
- **Device**: Room v4 (brand, `unitKind`, a `product_conversions` table replaced wholesale like
  barcodes), pack sizes and a brand and unit picker in the product editor, **Manage** gains Units &
  Brands (a kind is chosen, never typed), the adjust dialog offers the product's packs from Room and
  previews `10 crate = 240 ea` with the very `Units.convertQuantity` the server posts with — blocking
  an impossible conversion with the reason instead of queueing a command that would come back
  rejected — and history reads `10 crate → +240 ea`.
- **Conversions as one contract across languages**: `domain/units.ts`, `Units.kt` and `Units.swift`
  round half-up to 3 decimals and refuse a non-whole count with a **code**, never a message (whoever
  displays it writes the sentence). Vectors in `fixtures/unit-conversion.json` — 74/74 checks.
- **Scope agreed with the owner for 4.6**: units + brands only. Supplier product codes moved to
  Phase 7 (they need the supplier module) and variants stay as their own deferred row (D4d) needing
  an exit criterion before Phase 5 starts.
- Documented in `docs/operations/units-and-conversions.md`; 20 tests in `units-conversions.spec.ts`
  plus import and planner cases for the new columns.

#### Cross-branch stock transfers (v0.4.7, item 4.7)

The exit criterion is a conservation rule: **at no instant is the same stock counted in two
branches.** One document, two per-branch steps — the source dispatches, the destination receives,
and between those moments the goods belong to neither shelf but to the document.

- **Ledger facts only, branch-local.** A dispatch writes a *negative* movement at the source
  (`reason: 'transfer_out'`, `costMode: 'transfer'` — FIFO allocations recorded, **no `cogs_minor`:
  goods that left the shelves were not sold) and a receipt writes a *positive* one at the
  destination (`reason: 'transfer_in'`) opening a layer at the **carried cost** stamped on the line,
  so the two sides can never value the same goods differently. The device never computes either
  number's authority: it sends what was typed (`2 crate`), `applyMovement` converts once, and the
  document line stores `|baseQuantity|` while the movement remembers the signed entered pair
  (`entered_quantity = -2`).
- **The cost travels with the goods.** `unit_cost_minor = roundHalfUp(consumed / dispatched)`,
  falling back to `products.cost_minor` when nothing was costed — a branch must never hand goods
  over valued at nothing, and the fallback is the rule a receipt already follows (ADR 0009).
- **Owner decisions, built as agreed.** Every shortage needs a supervisor note (mirrors the negative
  adjustment override — refused *before* anything is written, so nothing half-applies); receiving
  more than was sent is refused with `RECEIVED_MORE_THAN_SENT` pointing at a supplier receipt; and a
  till lists only the documents its own branch is party to — the consolidated cross-branch view is
  Phase 9's owner dashboard (ADR 0008 item 5), no new permission invented for it.
- **Whole or not at all, twice.** Every line is resolved before the document is written
  (`EMPTY_TRANSFER` when none survive), the stock guard runs per line in base units
  (`INSUFFICIENT_STOCK`/`NEGATIVE_STOCK`, lifted by `approvalNote`), and a receipt must name every
  dispatched line and invent none (`MISSING_RECEIPT_LINE` / `UNKNOWN_RECEIPT_LINE`). A shortage is
  recorded **on the document only** — never a second movement, since those units already left.
- **Branch discipline is enforced at both doors.** `sync.pushOne` resolves the device's branch once
  per batch (`BRANCH_MISMATCH` for any command claiming another), and the list query's `branchId`
  is checked against enrolment too; a desk session with no device may read any branch of its own
  tenant (Phase 9 stands on this).
- **Numbering is server-owned.** `TRF-0001` from a tenant-wide series (`branch_id IS NULL`, made
  unique by a partial index so two branches cannot mint the same number), allocated under the row
  lock — a device that dispatched offline holds a document id but never a reference, and the screen
  says *queued on this device* until the server issues one.
- **Device**: Room v5 (`stock_transfers`, `stock_transfer_lines`, `branches`, `MIGRATION_4_5`), outbox
  commands with `aggregateType: StockTransfer` where dispatch and receipt share the document's
  `aggregateId`, and the transfer list refreshed after push+pull like the balance projection (a
  failed refresh never fails a sync). Screen: Stock → *Cross-branch transfers* with direction pills,
  per-row sync state **in words** (`Queued — pending on this device`, `Last synced …`,
  `Needs attention — <code>`), send-from-here with the pack conversion preview and a supervisor note
  that becomes required exactly when the server would refuse, count-what-arrived with every line
  prefilled and over-count blocked in place, and an *In transit from this branch* section under the
  stock rows naming the documents carrying what the shelf cannot count.
- Documented in `docs/operations/stock-transfers.md`; 18 endpoint tests in `transfers.spec.ts`
  (both halves end to end, the conservation and cost claims, every refusal, branch scoping,
  numbering, idempotent replay).

### Phase 5 — Offline POS vertical slice (current phase)

| # | Item | Exit criterion |
|---|---|---|
| 5.1 | Barcode scanning offline (**done**) | Scan resolves from Room with no network |
| 5.2 | Cashier session + role/permission gate on the till (D10) | A sale cannot be recorded without an open cashier session |
| 5.2a | Till refuses a sale that would take stock below zero (D7b, ADR 0009) | A cashier cannot oversell; the message names the item and the shortfall |
| 5.3 | Quantity/weight entry with unit conversion at the till | Selling 0.5 kg decrements the correct base quantity |
| 5.4 | Line and order discounts, with permission for overrides (D11) | Discounts are snapshotted on the line/document |
| 5.5 | Price override with permission + audit (D11) | Override is recorded with actor and reason |
| 5.6 | Customer assignment on a sale, plus sale notes (D11) | Sale carries the customer id and note offline |
| 5.7 | Cash payment first, with tender record and change due (D15 partial) | Cash sale produces exactly one tender row |
| 5.8 | Hold / resume sale (D12) | Held carts survive app restart |
| 5.9 | Void before finalisation (D12) | Void is audited; a posted sale cannot be voided |
| 5.10 | Receipt rendering + ESC/POS printing behind an adapter; local vs tax-invoice status (D13) | Printer failure never loses or duplicates the sale; receipt number stays stable |
| 5.11 | Sales history screen with per-sale sync state (D14) | Every sale's status is visible: pending, accepted, rejected, conflict |
| 5.12 | Reprint tracking (D13) | Reprints are counted and audited |

### Phase 6 — Cash management, shifts, refunds, end-of-day

| # | Item | Exit criterion |
|---|---|---|
| 6.1 | Cash sessions: open with float, cash in/out, paid-outs, safe drop | Every movement is an append-only row with an actor |
| 6.2 | Cash count, expected vs counted, variance with reason | Variance is computed and stored, not inferred |
| 6.3 | Shift close with supervisor approval | A finalised shift cannot be silently reopened or edited |
| 6.4 | Returns/refunds (D16) | A refund cannot exceed the eligible original quantities without an authorised exception |
| 6.5 | Exchange flow (D16) | Exchange nets correctly against stock and cash |
| 6.6 | Original-sale lookup for returns | Refund references the original sale where one exists |
| 6.7 | Offline session report + server-reconciled close report | Local and server totals reconcile, with differences surfaced |

### Phases 7–13

Detailed when current. Scope per §15: 7 customers/suppliers/debtors/creditors; 8 general ledger + reports;
9 owner dashboard + multi-device; 10 eTIMS/M-PESA adapters; 11 security/performance/pilot; 12 Android
release + licence lifecycle pilot; 13 native iOS.

---

## 5. Execution queue

Worked in this order, each item verified before the next begins:

1. **Phase 4 close-out** — 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7 → 4.8 → 4.9 → 4.10 → 4.11.
2. **Phase 5 completion** — 5.2 → … → 5.12, then the Phase 5 phone gate and `phase-05-apk-record.md`.
3. **Phase 6** in full, then its gate.
4. Residuals D25–D28 folded into their phases.
5. Phases 7–13.

---

## 6. Standing verification gate

| Check | Command | Expected |
|---|---|---|
| Domain fixtures | `npm run fixtures:check` | all checks pass |
| API tests | `npm --workspace apps/api run test` | all suites pass |
| API types | `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` | clean |
| Android build | `PHASE=NN VERSION=x.y.z bash infra/docker/android/build-apk.sh` | clean, **zero Kotlin warnings** |
| APK version | `aapt2 dump badging` | matches the artifact name |
| APK signature | `apksigner verify --print-certs` | internal-test identity (ADR 0005) |

`npm run verify` covers the first two. A phase is not complete until this gate is green **and** the phone
checklist in its `phase-NN-apk-record.md` is signed off.
