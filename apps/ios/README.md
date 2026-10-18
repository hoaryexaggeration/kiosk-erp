# iOS client (deferred to Phase 13)

Per §5 of the architecture, the iOS app is **specified now but implemented only in Phase 13**, after the
Android release candidate passes the field pilot. It cannot be compiled on Linux; this tree records the
target structure so the shared contracts stay honest.

## Target structure (§5)

```text
KioskERP/
├── App/                      # lifecycle, navigation, dependency composition
├── Core/
│   ├── Database/             # Core Data (SQLite store) or validated SwiftData; migrations
│   ├── Domain/               # value types, deterministic pricing/tax, use cases
│   ├── Network/              # API client, TLS, token refresh, error mapping
│   ├── Sync/                 # durable outbox/inbox, delta cursor, idempotency, conflicts
│   ├── Security/             # Keychain secrets, Data Protection, biometrics, session timeout
│   └── Device/               # AVFoundation scanning, accessories, printing, share
├── Features/                 # POS, Catalog, Inventory, Customers, Suppliers, Receivables,
│                             # Payables, Cash, Reports, Settings, SyncCenter, Licensing
└── DesignSystem/             # reusable SwiftUI components and accessibility states
```

## Choice to validate with a proof of concept before Phase 13

**Core Data vs SwiftData** — run a PoC for mature schema migration, background writes, large local
lists and schema evolution before committing the whole ERP to SwiftData (§5, [R4, R7]).

## Parity rules (§5)

- Same versioned OpenAPI contract and error schema as the Android client.
- Same JSON conformance fixtures (`packages/domain-fixtures`) — `Pricing.swift` here is the mirror
  implementation and MUST pass those vectors in Phase 13.
- Identical event names, stable IDs, schema versions and conflict codes.

`Core/Domain/Pricing.swift` is included now so the deterministic rule set has a second-language
reference; it is not yet wired to any UI.
