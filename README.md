# kiosk-erp

Offline-first native retail ERP / POS for kiosks, minimarkets and small multi-branch merchants.

Implements `offline_first_retail_erp_architecture.md`. **Android first**, cloud sync/control plane,
native iOS client deferred to the final phase (Phase 13).

> Build environment note: the day-to-day developer box for this repo has **no JDK/Android SDK**.
> Android APKs are therefore built inside a Docker container (JDK + Android SDK + Gradle), see
> `infra/docker/android/`. iOS cannot be compiled on Linux at all and is scaffolded only.

## Repository layout

```text
kiosk-erp/
├── apps/
│   ├── android/                 # Kotlin + Compose native Android (buildable via Docker)
│   │   ├── app/                 # composition root: Application, activity, DI, navigation, theme
│   │   ├── core/                # common (domain), database (Room), network, security, data (repos+sync)
│   │   └── feature/             # one module per domain: dashboard, pos, catalog, inventory,
│   │                            #   sync, license, settings  (see ADR 0007)
│   ├── ios/                     # Swift + SwiftUI native iOS (implementation deferred to Phase 13)
│   └── api/                     # NestJS TypeScript backend (modular monolith)
├── packages/
│   ├── api-contract/            # OpenAPI source and generated-client metadata
│   ├── domain-fixtures/         # Language-neutral JSON rule/test vectors (money, tax, sync)
│   └── integration-contracts/   # Provider mapping specs and mock fixtures
├── infra/
│   ├── docker/                  # Local containers (postgres, api, android-builder)
│   ├── migrations/              # Database migration/release workflow docs
│   ├── deploy/                  # Staging/production deployment configuration
│   └── observability/           # Dashboards, alert definitions, runbooks
├── docs/
│   ├── architecture/            # ADRs, diagrams, threat model
│   ├── product/                 # Requirements, workflows, permissions
│   ├── accounting/              # Posting matrix approved by accountant
│   ├── compliance/              # Tax/privacy/provider onboarding evidence
│   └── operations/              # Backup, recovery, sync-conflict runbooks
└── tests/
    ├── contract/               # API contract and cross-client fixtures
    ├── sync-scenarios/         # Network fault/replay/conflict scenarios
    └── acceptance/             # End-to-end retail workflows
```

## Status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Discovery/workspace | ✅ docs/product/phase-0-discovery.md, ADRs 0001–0006 |
| 1 | Domain contracts + fixtures | ✅ `packages/domain-fixtures` (34 checks), sync protocol spec |
| 2 | Backend foundation | ✅ NestJS API, Postgres migrations, auth/RBAC, devices, catalog, licensing (JWS ES256) |
| 3 | Android shell, local DB, sync center | ✅ APK `artifacts/retail-erp-p03-v0.3.0.apk`; see `docs/operations/phase-03-apk-record.md` |
| 4 | Catalogue, pricing/promotions, inventory | ✅ APK `artifacts/retail-erp-p04-v0.4.1.apk`; multi-module split (ADR 0007); launcher icon + nav cleanup; see `docs/operations/phase-04-apk-record.md` |
| 5–12 | Full POS → release candidate | ⏳ planned (see `docs/operations/roadmap.md`) |
| 13 | Native iOS client | ⏳ scaffolded in `apps/ios/` |

Verified locally: 26/26 API tests (unit + integration against Docker Postgres) and 34/34 fixture
conformance checks. Android APK is built and signed (`assembleDebug`) inside Docker.

## Quick start

```bash
# 1. Postgres for local dev
npm run db:up

# 2. Backend
npm install
npm --workspace apps/api run migration:run
npm run api:dev            # http://localhost:3000/v1/health

# 3. Tests + fixture conformance
npm run verify

# 4. Android APK (inside Docker; no host JDK required)
npm run android:build      # writes artifacts/retail-erp-pXX-*.apk
```

### Setting up a physical phone (not the emulator)

The app's default API address `http://10.0.2.2:3000/v1` is the **emulator's** alias for this
computer — it resolves to nothing on a real handset, and setup fails with "cannot reach". On a
phone on the same network:

1. Find this computer's own address: `ip -4 addr show` (e.g. `172.21.219.155`).
2. In the phone's browser, open `http://<that address>:3000/v1/health` — it must return JSON
   (`{"status":"ok",…}`). If it does not, the API (`npm run api:dev`) is not running or the phone
   is on a different network.
3. In the app: **Settings → API address** → `http://<that address>:3000/v1` (keep the `/v1`),
   then **Set up** with `owner@kiosk.test` / `demo1234`.

## Documentation index

- `docs/product/phase-0-discovery.md` — workflow map, MVP boundaries, permission matrix, offline capability matrix
- `docs/architecture/adr/` — architecture decision records
- `docs/architecture/sync-protocol.md` — command envelope, push/pull, idempotency, conflicts
- `docs/accounting/posting-matrix.md` — double-entry posting rules (draft, accountant sign-off required)
- `docs/operations/` — backup, recovery and sync-conflict runbooks; per-phase APK records
- `docs/operations/roadmap.md` — phase checklist (5→13) and the standing verification gate

## Design rules (non-negotiable)

See Section 1.6 of the architecture document. Summary: no network dependency in the cashier core loop;
every local write is one DB transaction; queued transactions are never silently lost; money and stock
movements are append-only facts; the cloud is authoritative for shared state; never claim realtime
visibility into unsent offline events.
