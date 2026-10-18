# Roadmap and phase checklist

> **Source of truth.** The authoritative 13-phase decomposition lives in
> `offline_first_retail_erp_architecture.md` §15, which is **not committed to this repository**. The
> phase names below are our working decomposition and have been kept consistent with the work done so
> far; where a phase number is inferred rather than quoted, it is marked _(inferred)_.

Each phase ends with the **mandatory APK delivery gate**: an installable, internally-signed APK plus a
`docs/operations/phase-NN-apk-record.md`, including a phone test checklist the owner runs.

## Standing verification (run before every phase commit)

| Check | Command | Expected |
|---|---|---|
| Fixture conformance | `npm run fixtures:check` | 34/34 |
| Backend tests | `npm --workspace apps/api run test` | all pass |
| Backend types | `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` | clean |
| Android build | `PHASE=NN VERSION=x.y.z bash infra/docker/android/build-apk.sh` | clean, **zero Kotlin warnings** |
| APK signature | `apksigner verify --print-certs <apk>` | internal-test identity (ADR 0005) |
| APK integrity | checksum via recorded `.sha256` | matches |

`npm run verify` covers the first two.

## Pre-Phase-5 polish (owner-requested)

| # | Item | State |
|---|---|---|
| P1 | Adaptive launcher icon (teal receipt mark) + manifest `icon`/`roundIcon` | ✅ |
| P2 | Bottom navigation reduced to Material's 3–5 recommendation; Catalogue and License moved behind Setup | ✅ |

## Phases

### Phase 5 — Full POS: scanning, receipts, more commands _(partly inferred)_

| # | Deliverable | Exit criteria | State |
|---|---|---|---|
| 5.1 | Camera barcode scanning on the POS screen | Scan resolves a product and adds it to the cart offline | ⏳ |
| 5.2 | Receipt printing via an adapter interface | A cash sale prints a receipt (or records a durable print failure) | ⏳ |
| 5.3 | Additional offline operations beyond `Sale` (returns, no-sale) | Each new aggregate posts canonically and idempotently server-side | ⏳ |

### Phase 6 — Cash sessions and sync hardening _(inferred)_

| # | Deliverable | Exit criteria | State |
|---|---|---|---|
| 6.1 | Cash shift / session open–close, float and count | Session totals reconcile; `cashSessionId` populated | ⏳ |
| 6.2 | Sync fault-injection harness under `tests/sync-scenarios/` | Replay, mid-page failure, duplicate push, clock skew all provably safe | ⏳ |

### Phases 7–12

| Phase | Theme (working name) | State |
|---|---|---|
| 7 | Purchasing / supplier bills / stock receiving workflow | ⏳ |
| 8 | Accounting: canonical postings per the accountant-approved matrix | ⏳ |
| 9 | Customers, credit terms, statements | ⏳ |
| 10 | Reporting and exports | ⏳ |
| 11 | Integrations (payments, fiscal/eTIMS, providers) | ⏳ |
| 12 | Release candidate hardening | ⏳ |

### Phase 13 — Native iOS client

| # | Deliverable | Exit criteria | State |
|---|---|---|---|
| 13 | Swift/SwiftUI port | Cross-client fixture parity with Kotlin/TypeScript | ⏳ scaffold only |

## Open owner sign-offs (block later phases, not progress)

- eTIMS / fiscalisation path (Phase 11).
- Accountant sign-off on `docs/accounting/posting-matrix.md` (Phase 8).
- Kenya DPA data-protection review.
- Phase 0 discovery sign-off.
