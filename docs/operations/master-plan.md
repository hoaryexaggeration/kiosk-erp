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
| 1 | Domain contracts, data model, sync spec | 🟡 | Fixtures, sync protocol, posting matrix, ADRs exist; **no OpenAPI skeleton, no ERD, no state machines beyond `Sale`, no event-version policy, no UoM/unit-conversion spec** |
| 2 | Backend foundation and cloud controls | 🟡 | NestJS + Postgres + auth/RBAC + devices + licensing + outbox work; **no CI, no staging deploy, no backups/restore drill, no OpenAPI generation, no rate limits, `LicenseBillingModule` absent** |
| 3 | Native shell, local DB, sync center | 🟡 | Shell, Room, push/pull, Sync Center, enrolment work; **`LicenseManager` request export (`.licreq`/QR), entitlement display, Keystore installation key, replay/rollback detection, app lock/offline expiry absent** |
| 4 | Catalogue, pricing, inventory ledger | 🟡 | Products/barcodes/tax/categories/promotions + movement ledger + balances work; **no product management UI, no bulk import, no UoM/conversions/variants/brands, no price lists/scheduled prices, no transfers, no stocktake, no low-stock thresholds, no movement history UI, no opening-stock import** |
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
| `core:designsystem` | absent | **Create `:core:designsystem`**: typography, spacing, offline/loading/error/empty states |
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
| D1 | Product/category/tax **management UI** (server CRUD exists) | §3.C, §15 Ph4 | 4 | ☐ |
| D2 | Bulk product import with preview/validation/error report (`POST /v1/products/import`) | §9, §15 Ph4 | 4 | ☐ |
| D3 | Opening-stock import workflow (seeded opening stock with FIFO layers exists) | §15 Ph4 | 4 | ◐ |
| D4 | Units of measure + conversions, variants, brands, supplier product codes | §3.C | 4 | ☐ |
| D5 | Price lists, branch/customer/scheduled prices, price-change history | §3.C | 4 | ☐ |
| D6 | Stock transfers with dispatch/receipt states | §3.D, §15 Ph4 | 4 | ☐ |
| D7 | Stocktake / cycle count | §3.D, §15 Ph4 | 4 | ☐ |
| D7a | Stock valuation is **FIFO with valuation layers** (ADR 0009), replacing weighted average | §7, §18.5 | 4 ✔ | ✔ |
| D7b | Till blocks a sale that would take stock negative; `UNCOSTED_STOCK` resolution path | §18.5 | 5 | ☐ |
| D7c | Branch edge gateway (ADR 0010) — new MVP component | §6, §17 | 5–11 | ☐ |
| D8 | Low-stock/reorder thresholds + alerts | §3.D | 4 | ☐ |
| D9 | Editing barcodes on an existing product (`PATCH /v1/products/:id`) | §3.C | 4 | ☐ |
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
| D27 | Adopt `:core:domain`, `:core:sync`, `:core:device`, `:core:designsystem` module split | §5 | 3 residual | ☐ |
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
| 4.1 | `PATCH /v1/products/:id` accepts `barcodes`; device replaces that product's barcodes transactionally (D9) | A barcode added on the server resolves on a device after sync; removed barcodes stop resolving |
| 4.2 | Product management UI: list/search, create, edit, deactivate; barcodes, category, tax category, unit, cost, price | A product created on the phone reaches the server and back without hand-editing SQL |
| 4.3 | Category + tax-category management UI | Same |
| 4.4 | Bulk import: CSV/JSON upload → **preview → validation → per-row error report → commit** (D2) | A malformed file creates **no partial records** and reports every bad row |
| 4.5 | Opening stock import (D3) | Opening balances arrive as stock movements, never as a direct quantity edit |
| 4.6 | Units of measure + conversions (D4) | Buying in crates and selling in pieces keeps one stock ledger |
| 4.7 | Cross-branch stock transfers with dispatch/receipt/discrepancy states (D6, ADR 0008) | Stock is in exactly one branch or in transit, never both |
| 4.8 | Stocktake / cycle count (D7) | A count produces adjustment movements with reason and actor |
| 4.9 | Low-stock thresholds and alerts (D8) | Threshold breach is visible on the Stock screen |
| 4.10 | Movement history UI per product/location (D8) | Every balance can be traced to the movements that produced it |
| 4.11 | Price lists / branch prices / scheduled prices + price-change history (D5) | A price change is versioned; a stale device price is flagged, never silently overwritten |

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
