# Sync protocol (v1)

Implements §6 of the architecture. This document is the normative contract shared by the NestJS API,
the Android client and (later) the iOS client. All three MUST agree on command ids, states, cursor
semantics and conflict codes.

## 1. Command envelope

Every syncable command carries at least:

```json
{
  "commandId": "2f0c2c1e-...-uuid",
  "tenantId": "tenant-uuid",
  "branchId": "branch-uuid",
  "deviceId": "enrolled-device-uuid",
  "actorId": "user-uuid",
  "aggregateType": "Sale",
  "aggregateId": "client-generated-uuid",
  "aggregateVersion": 1,
  "localSequence": 1042,
  "clientCreatedAt": "2026-10-18T07:21:09Z",
  "schemaVersion": 1,
  "idempotencyKey": "stable-key-for-this-operation",
  "dependsOn": [],
  "payload": { "...": "domain-specific" }
}
```

The server **derives tenant/actor scope from the authenticated session** and validates the envelope;
the client cannot choose arbitrary tenant/actor identities. `clientCreatedAt` is diagnostic only —
canonical ordering uses server sequence.

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/sync/push` | Send a bounded batch of pending commands; one result per command |
| `GET`  | `/v1/sync/pull?cursor=…&limit=…` | Ordered tenant-scoped server deltas + a new opaque cursor |
| `GET`  | `/v1/sync/status` | Diagnostics: last push/pull, pending, rejected, oldest pending age |
| `POST` | `/v1/sync/conflicts/:id/resolve` | Audited resolution of a conflict case |
| `POST` | `/v1/devices/enroll` | Register a device through an authenticated owner/admin flow |

## 3. Synced aggregates and server-side authority

A synced command is applied only if the **authenticated actor holds the aggregate's permission** —
a device token is proof of enrollment, never of authority. Permissions are checked server-side inside
the push transaction; a missing permission yields `rejected` / `FORBIDDEN`.

| `aggregateType` | Required permission | Payload (abridged) | Effect |
|---|---|---|---|
| `Sale` | `pos.sale.create` | `{ sale: { id, lines[], tenders[] } }` | Canonical sale + stock movements + AR + journal |
| `StockReceipt` | `inventory.receive` | `{ receipt: { id, reason, lines[{ productId, quantity, unitCostMinor? }] } }` | Append stock in; roll weighted-average cost |
| `StockAdjustment` | `inventory.adjust` | `{ adjustment: { id, reason, lines[{ productId, quantityDelta }] } }` | Append signed movement; `reason` mandatory |

Unknown aggregates return `rejected` / `UNSUPPORTED_AGGREGATE`. Every `conflictCodes` entry returned by
an aggregate becomes a durable `conflict_cases` row (Phase 4 centralised this in the sync layer so all
aggregate types get identical, auditable exception handling).

## 4. Push result states

For each command the server returns exactly one of:

| State | Meaning | Client action |
|---|---|---|
| `accepted` | Applied; canonical effects posted | Advance local status; store server ids/version |
| `duplicate` | Already processed (same `commandId`) | Treat as `accepted`; do not re-post |
| `retryable` | Transient failure (e.g. DB contention) | Retry **with the same commandId** |
| `rejected` | Business rule violation | Moves to conflict inbox; requires action |
| `conflict` | Version/idempotency conflict | Conflict inbox with a `conflictId` |
| `review_required` | Needs supervisor (e.g. offline credit breach) | Conflict inbox, high visibility |

## 5. Idempotency rules (§6)

- `commandId` is unique and immutable.
- The server stores processed command ids and their outcomes under a **unique constraint**
  (`processed_commands(tenant_id, command_id)`).
- A duplicate request returns the **original result**; it creates no second invoice/payment/stock move.
- A retry **reuses the same commandId**. A new key on a retry can double-post — this is a defect.
- Payment provider callbacks use the provider's event/reference id under the same unique discipline.

## 6. Pull / cursor semantics

- Server deltas are ordered by `server_events.seq` (monotonic, server-assigned).
- The client **advances its cursor only after the entire corresponding page is durably committed
  locally**.
- Pull is idempotent: re-pulling an acknowledged cursor returns no already-applied events (the client
  may also skip events `<= cursor`).
- The cursor is **opaque** to the client.

## 7. Conflict policy (§6)

**Never use blanket last-write-wins for money, quantities, payments, accounting entries, returns or
posted documents.**

| Conflict type | Code | Behaviour |
|---|---|---|
| Append-only sale/payment/stock events | `EVENT_ACCEPTED` | Accept each unique event once; create canonical projection |
| Same entity edited on two devices | `VERSION_MISMATCH` | Optimistic version check; merge only explicitly mergeable fields |
| Price/tax changed while offline | `STALE_PRICE_SNAPSHOT` | Keep sale-time snapshot + version; flag if policy disallows |
| Credit limit exceeded after another sale | `CREDIT_EXCEEDED` | Preserve sale evidence; raise receivable exception (never delete) |
| Stock negative due to independent tills | `NEGATIVE_STOCK` | Preserve movement facts; raise stock conflict; block per policy |
| Duplicate provider callback / manual reference | `DUPLICATE_PROVIDER_REF` | Unique provider id; reconciliation queue |
| Revoked user/role while offline | `OFFLINE_PERMISSION_EXPIRED` | Apply revocation on reconnect; limited offline validity window |
| Deleted master referenced by pending sale | `DELETED_REFERENCE` | Tombstones + retained snapshots; never hard-delete referenced data |

## 8. Transport requirements (§6)

TLS; bounded payloads (default 200 commands / request, 500 deltas / page); gzip where useful;
pagination; correlation ids on every request/response; exponential backoff **with jitter**;
network-aware scheduling; request timeouts; server-side rate limits.

## 9. Failure-visibility rule (§1.6 rule 3, §12)

Pending, accepted, rejected and conflict states MUST be visible and recoverable. A user cannot clear a
failure by dismissing a warning. Screens that depend on shared/cached data show data age, last sync
and pending count. A green network icon is insufficient.
