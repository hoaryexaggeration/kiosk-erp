# Phase roadmap

Phase names and gates are taken verbatim from §15 of `offline_first_retail_erp_architecture.md` (v1.2).
The **detailed, granular plan — including the current-state audit, the architecture conformance ledger and
the deferred-items ledger — is in `docs/operations/master-plan.md`**.

## Android APK delivery gate (§15)

Every phase 0–12 ends with an installable, internally-signed APK plus
`docs/operations/phase-NN-apk-record.md` containing: phase + semantic version, build identifier,
SHA-256, changelog, expected environment, known limitations, and the phase-specific phone-test checklist
with pass/fail results. A failed test blocks the phase. The iOS client is Phase 13 and produces an
IPA/TestFlight build, not an APK.

## Phases

| Phase | Deliverable (§15) | State |
|---|---|---|
| 0 | Discovery, workflow mapping and compliance questions | 🟡 APK `p03`+ shipped later; owner sign-off + §18 decision register outstanding |
| 1 | Domain contracts, data model and sync specification | 🟡 fixtures, sync protocol, ADRs; OpenAPI/ERD/state machines outstanding |
| 2 | Backend foundation and cloud controls | 🟡 API, auth, devices, licensing, outbox; CI/staging/backups outstanding |
| 3 | Native shells, local database and sync center | 🟡 shell, Room, push/pull, Sync Center; `LicenseManager` export + app lock outstanding |
| 4 | Catalogue, pricing and inventory ledger | 🟡 **close-out in progress** — 4.0–4.6 and 4.10 done (FIFO valuation ADR 0009, barcode editing, catalogue management UI, bulk import, opening stock as movements, movement history, units + pack conversions + brands); UI usability pass at v0.4.3, scan-to-add + demo catalogue at v0.4.4, opening-stock import at v0.4.5, units/conversions/brands at v0.4.6; transfers, stocktake, low-stock and price lists next |
| 5 | Offline POS vertical slice | 🟡 scanning done; session, oversell block, discounts, hold/void, receipts, history to do |
| 6 | Cash management, shifts, refunds and end-of-day | ⏳ refunds live here, not in Phase 5 |
| 7 | Customers, suppliers, debtors and creditors | ⏳ |
| 8 | General ledger and core reports | ⏳ |
| 9 | Owner dashboard and multi-device operations | ⏳ |
| 10 | KRA eTIMS, M-PESA and other provider adapters | ⏳ |
| 11 | Security hardening, performance and field pilot | ⏳ |
| 12 | Android release, monitoring and controlled expansion | ⏳ |
| 13 | Final native iOS client build | ⏳ scaffold only (deferred by design) |

## Standing verification gate

Run before every phase commit: `npm run verify` (domain fixtures + API tests), clean `tsc`, clean Android
build with **zero Kotlin warnings**, and `aapt2`/`apksigner` checks on the APK. See `master-plan.md` §6.

## Open owner sign-offs

Block later phases, not day-to-day progress:

- ~~§18 decision register~~ — **resolved 19 Oct 2026**: see `docs/product/decision-register.md`. It
  changed real scope: multiple branches (ADR 0008), FIFO valuation (ADR 0009), and the branch edge
  gateway moving into the MVP (ADR 0010).
- Receipt printer model and whether a cash drawer is required (needed before Phase 12).
- Hosting, backup and disaster-recovery expectations for the cloud and the per-branch gateway.
- KRA eTIMS path and accountant sign-off on chart of accounts, tax treatment, cost method and close
  reports (Phase 8/10).
- Kenya Data Protection Act review (Phase 11).
