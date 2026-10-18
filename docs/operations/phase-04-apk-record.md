# Phase 4 — APK delivery record

Required by §15 "Mandatory Android APK delivery gate". Every field below is part of the gate.

| Field | Value |
|---|---|
| **Phase** | 4 — Catalogue, pricing/promotions and inventory (+ post-phase polish) |
| **App version** | `0.4.1` (versionCode 5) |
| **Artifact** | `artifacts/retail-erp-p04-v0.4.1.apk` |
| **SHA-256** | `74caefeab641af20b08eb039759629072eaf9981adf0b2a08cb1489e7ef3b108` |
| **Size** | ~17.9 MB |
| **Signing** | **Stable internal-test key** (`CN=Kiosk ERP Internal Test`, cert SHA-256 `935c0fbc6993db9ca761b4c3610c71a50d91897fd9b1753d0da3e56dffd056dd`), generated once by `build-apk.sh` and git-ignored (ADR 0005) |
| **Build** | Docker image `kiosk-erp-android-builder` (JDK 17 + Android SDK 34 + Gradle 8.7); `PHASE=04 VERSION=0.4.0 bash infra/docker/android/build-apk.sh` |
| **Expected backend** | `apps/api` on `http://<host>:3000/v1`; seed tenant/branch from `seed-dev.ts` |

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
  receipts and adjustments. `StockReceipt` rolls a **weighted-average cost**; `StockAdjustment`
  requires a reason. Read models `GET /v1/inventory/balances` and `/movements`.
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

## Verification

- `npm --workspace apps/api run test`: **26/26** pass (unit + integration against Docker Postgres),
  including a new `inventory.spec.ts` (receipt → weighted-average cost, idempotency, adjustment,
  negative-stock `review_required` + `NEGATIVE_STOCK` case, read models, and cashier `FORBIDDEN`) and
  `catalog-pricing.spec.ts` (tax rates in the catalogue, optimistic version bump + `VERSION_MISMATCH`,
  product delta events, and `asOf` promotion resolution).
- `npm run fixtures:check`: 34/34.
- `tsc -p tsconfig.build.json --noEmit`: clean.
- Docker APK build across 13 Gradle modules: clean, **zero Kotlin warnings**.
- APK signature verified with `apksigner verify --print-certs` (internal-test identity, see table).

## Known limitations (phase-scoped)

- Signed with an **internal-test** key (not a store key); fine for owner testing, not for distribution.
- Receipts are touch-entry only; camera barcode scanning and printer adapters remain Phase 5.
- No shift/session screen yet (Phase 6); `cashSessionId` is nullable.
- Adjustments support a single line per command in the UI (the server accepts multi-line).
- Costing uses branch-level weighted average on receipt only; full stocktake reconciliation and
  approvals (`approved_by` is persisted but not yet populated by a UI flow) land later.
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

A failure involving lost transactions, duplicate posting, corrupted local data or a false
payment/tax status blocks the phase.
