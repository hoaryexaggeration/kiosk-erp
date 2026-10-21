# Phase 05 — APK delivery record (offline POS vertical slice)

Running record for every APK shipped from Phase 5, in the same shape as the Phase 04 record.
Item 5.2 (cashier session + role gate, D10) is the first entry.

| Field | Value |
|---|---|
| **Phase** | 5 — Offline POS vertical slice |
| **App version** | `0.5.0` (versionCode 500) |
| **Artifact** | `artifacts/retail-erp-p05-v0.5.0.apk` |
| **SHA-256** | `132fff7c674088ac33aeeb6b69eb80a2ccedf845ebc30b139daa23f6e98380cb` |
| **Size** | ~42.5 MB (42,460,341 bytes; bundled ML Kit barcode models, unminified debug build) |
| **Signing** | **Stable internal-test key** (`CN=Kiosk ERP Internal Test`, cert SHA-256 `935c0fbc6993db9ca761b4c3610c71a50d91897fd9b1753d0da3e56dffd056dd`), generated once by `build-apk.sh` and git-ignored (ADR 0005) — upgrades in place over every Phase 4 build |
| **Build** | Docker image `kiosk-erp-android-builder` (JDK 17 + Android SDK 34 + Gradle 8.7); `PHASE=05 VERSION=0.5.0 bash infra/docker/android/build-apk.sh` |
| **Expected backend** | `apps/api` on `http://<host>:3000/v1` with migration `0008`; seed tenant + **two** branches (Main Kiosk, West Kiosk) and the 20-product demo catalogue — see `demo-catalogue.md`. New in this build: `GET /v1/cash/sessions/current` + `GET /v1/cash/sessions/:id`, and `CashSessionOpen`/`CashSessionClose` sync commands |

**Build history inside Phase 5** (each signed with the same stable key, so each upgrades in place):

| Version | versionCode | SHA-256 (first 16) | What landed |
|---|---|---|---|
| `0.5.0` | 500 | `132fff7c674088ac` | Cashier session + role gate (5.2, D10): the drawer opens and closes at the till offline as server-refereed commands; every sale requires a valid open session; offline permission gate from the cached role |

## Changelog

**v0.5.0 — cashier sessions and the drawer gate (item 5.2, D10).**

Server (`apps/api`):

- **`CashModule`**: `CashService.open/close` run inside the push transaction (idempotent by
  command; a replayed open is a `duplicate`, a new command naming an existing session is a
  no-op), plus read-only `GET /v1/cash/sessions/current?branchId=` and `GET /v1/cash/sessions/:id`.
  Opening a **second** drawer on one branch is refused as `SESSION_ALREADY_OPEN` — a named
  conflict case, never a silent pick, because two drawers would make the day's cash
  unreconcilable.
- **The count is a reading.** Closing takes the till's counted cash; the **expected** figure is
  derived server-side (float + cash tendered on that session's sales — card and M-PESA never
  entered the drawer), `variance = counted − expected` recorded with the actor in `audit_events`.
  Paid-outs, safe drops and refunds join the derivation in Phase 6.
- **The sale gate.** `SalePayloadSchema` now REQUIRES `cashSessionId`, and `applySale` re-checks
  the session against the sale's own clock (`clientCreatedAt` — offline sales arrive after the
  drawer closes, so posting time proves nothing): `SESSION_REQUIRED`, `SESSION_BRANCH_MISMATCH`
  and `SESSION_NOT_OPEN`, each promoted to the push result with a human-readable message (§6). A
  refused sale writes nothing.
- **Permissions**: `CashSessionOpen` → `cash.shift.open`, `CashSessionClose` →
  `cash.shift.close`, enforced server-side on every push regardless of what the device believes.
- **Tests**: new `cashier-session.spec.ts` (10: open + branch-scoped current read, in-window
  sale, schema refusal, phantom session, before-open/after-close refusals, the second-drawer
  conflict with its conflict case, replay/no-op re-open, close derivation + audit, and the role
  gate with a no-roles user). `sync-sale.spec` and `price-overrides.spec` now open a drawer
  first — **181/181 across 16 suites**.

Android:

- **Room v8** (`MIGRATION_7_8`): `cash_sessions` (`CashSessionEntity`), the till's own truth
  about its drawer, written offline and travelled as `CashSessionOpen`/`CashSessionClose` outbox
  commands — an offline open survives a restart.
- **Point of Sale**: a drawer bar states the gate where the cashier stands (*Drawer closed — a
  sale cannot be recorded* / *Drawer open · float …*), with open (opening float) and close
  (counted cash) dialogs. Checkout is refused at the button when no drawer is open or the
  cached role lacks `pos.sale.create`, naming exactly what is missing; the sale then carries its
  `cashSessionId` in both the local row and the pushed payload.
- **Role gate offline**: permission codes are cached in `SessionStore` at sign-in from
  `GET /v1/auth/me`, so the till gates itself with the radio off — the server re-checks every
  one regardless.
- **Diagnostics**: the sync screen's test-sale helper now routes through the open drawer (a
  diagnostics sale with no drawer would be refused by the server anyway) and says so.

## Verification

- `npm run verify` (fixtures + API tests): **74/74** domain-fixture checks and **181/181 API
  tests** across 16 suites — the previous 15 plus **cashier-session (10)**; `sync-sale` and
  `price-overrides` reworked to open a drawer first — against Docker Postgres.
- `tsc -p tsconfig.json --noEmit`: clean.
- Android: clean `assembleDebug` under `--no-build-cache` at versionCode 500 / 0.5.0 with
  **zero Kotlin warnings**; `aapt2` reports `versionCode='500' versionName='0.5.0'`;
  `apksigner` reports the stable internal-test cert above.

## Known limitations (phase-scoped)

- The expected-cash derivation counts cash-tendered sales only: paid-outs, safe drops, cash
  in/out and refunds join it in Phase 6 (with supervisor sign-off on variance).
- One open drawer per branch; multi-till sharing a branch is refused rather than reconciled —
  Phase 6 owns cash accountability design.
- The till's close dialog records the count locally; expected/variance are shown once the close
  command has landed and the session is read back.

## Phone test checklist (owner runs on a physical Android device)

| # | Test | Pass/fail |
|---|---|---|
| 1 | Install this build **over** the Phase 4 build (v0.4.12) → local data is kept, no startup crash | ☐ |
| 2 | POS opens with the drawer bar reading *Drawer closed — a sale cannot be recorded*; adding an item and pressing checkout is refused with *Open the drawer first* | ☐ |
| 3 | **Open drawer** with float `2000` → the bar reads *Drawer open · float 2000.00 KES*; the notice confirms; airplane mode on → still open after an app restart | ☐ |
| 4 | Scan/search an item, add to cart, checkout → a receipt number and total appear; the sale sits in the local list as pending | ☐ |
| 5 | **Close drawer** with a counted figure → the bar returns to *Drawer closed*; with the radio off it says it uploads with the next sync | ☐ |
| 6 | Reconnect + **Sync now** → the open/close commands and the sale are accepted; the Sync Centre shows no rejected command; the server's session row shows the derived expected and your variance | ☐ |
| 7 | Sign in as `cashier@kiosk.test` (Setup) → POS still sells (the role has `pos.sale.create`); a user without it sees *This user cannot create sales* | ☐ |
| 8 | Open the drawer, then try to open it again → refused with the one-drawer-per-branch rule (server-side; visible after sync as a named conflict if forced from a second device) | ☐ |

A failure involving lost transactions, duplicate posting, corrupted local data or a false
payment/tax status blocks the phase.
