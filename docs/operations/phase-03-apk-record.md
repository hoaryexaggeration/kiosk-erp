# Phase 3 — APK delivery record

Required by §15 "Mandatory Android APK delivery gate". Every field below is part of the gate.

| Field | Value |
|---|---|
| **Phase** | 3 — Native shells, local database and sync center |
| **App version** | `0.3.0` (versionCode 3) |
| **Artifact** | `artifacts/retail-erp-p03-v0.3.0.apk` |
| **SHA-256** | `cce82508cbda477902f6d20578f2c6f1b81e5ae455676a03240d5ee0b635d161` |
| **Size** | ~17.8 MB |
| **Signing** | Android **debug** keystore (internal test only; a stable internal-test keystore must replace this before owner testing so upgrades preserve data — see ADR 0005) |
| **Build** | Docker image `kiosk-erp-android-builder` (JDK 17 + Android SDK 34 + Gradle 8.7); `bash infra/docker/android/build-apk.sh` |
| **Expected backend** | `apps/api` on `http://<host>:3000/v1`; seed tenant/branch from `seed-dev.ts` |

## Changelog

- Kotlin + Jetpack Compose app shell with bottom navigation (Dashboard, POS, Catalogue, Sync, License, Setup).
- Room local database: products, barcodes, sales, sale_lines, tenders, outbox, sync_state (version 1).
- **Atomic offline write path**: `SaleRepository.createCashSale` writes sale + lines + tender + outbox in a single Room transaction — no network call on the cashier path.
- Durable command **outbox** with per-command status/attempts; `SyncEngine` pushes with the same `commandId` and pulls ordered deltas with a cursor.
- Sync Center: pending count, oldest-pending age, needs-attention list, "Sync now", "Create offline test command".
- Offline **license package import** using the vetted Nimbus JOSE library (ES256, pinned `alg`+`kid` allowlist).
- Setup screen: login → device enrollment → device-bound login (DataStore session).
- Proportional pricing/tax implementation mirroring `packages/domain-fixtures`.

## Known limitations (phase-scoped)

- Debug keystore; not upgrade-stable yet.
- Sales use touch entry; camera barcode scanning and printer adapter are Phase 4/5.
- No working shift/session screen yet (Phase 6); `cashSessionId` is nullable.
- Catalogue refresh maps all products to a single default tax rate until tax-category sync lands (Phase 4).
- Only `Sale` commands are dispatched server-side; other aggregates reject with `UNSUPPORTED_AGGREGATE`.

## Phone test checklist (owner runs on a physical Android device)

| # | Test | Pass/fail |
|---|---|---|
| 1 | App installs and launches; Dashboard shows version/labels; no startup crash | ☐ |
| 2 | Setup: enter API URL + `owner@kiosk.test` / `demo1234` + branch id → "Device enrolled and ready to sync" | ☐ |
| 3 | POS: add items → "Charge cash" → receipt shows **Saved on this device** + **waiting to sync** | ☐ |
| 4 | Enable **airplane mode** → make a sale → sale persists after force-close/reopen | ☐ |
| 5 | Sync Center shows **Pending on this device (N)** while offline, and the oldest-pending age | ☐ |
| 6 | Disable airplane mode → **Sync now** → pending drops to 0, no duplicate is created (verify one server sale) | ☐ |
| 7 | Create an offline test command → force-close → reopen → reconnect → exactly one server acceptance | ☐ |
| 8 | License: paste issuer public key + a signed package → "Package verified"; tampered package is rejected | ☐ |

A failure involving lost transactions, duplicate posting, corrupted local data or a false payment/tax
status blocks the phase.
