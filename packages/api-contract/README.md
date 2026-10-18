# API contract

Source of truth for the versioned HTTP contract shared by the Android client, the (Phase 13) iOS
client and the NestJS backend.

- Routes are versioned from the start: `/v1/...` (§9).
- Errors use the structured contract: `{ code, message, fieldErrors?, retryable, conflictId?, correlationId }`.
- Sync endpoints and semantics: see `docs/architecture/sync-protocol.md`.

## Endpoints implemented so far

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/health`, `/v1/health/ready` | Liveness/readiness (public) |
| `POST` | `/v1/auth/login` | Returns access + rotating refresh tokens |
| `POST` | `/v1/auth/refresh` | Rotation with reuse detection |
| `POST` | `/v1/auth/logout` | Revokes the token family |
| `GET` | `/v1/auth/me` | Current user + effective permissions |
| `GET` | `/v1/devices/me` | Device detail (bumps last_seen) |
| `GET` | `/v1/devices` | List tenant devices (`admin.device.manage`) |
| `POST` | `/v1/devices/enroll` | Enroll/renumber a device (`admin.device.manage`) |
| `POST` | `/v1/devices/revoke` | Revoke a device + its tokens (`admin.device.manage`) |
| `GET` | `/v1/products` | Cached catalogue paging (includes resolved tax rate) |
| `POST` | `/v1/products` | Create product (`catalog.manage`) |
| `PATCH` | `/v1/products/:id` | Update product with optimistic `expectedVersion` (`catalog.manage`) |
| `GET` | `/v1/barcodes/:code` | Barcode → product |
| `GET` | `/v1/tax-categories` | Tax categories (rate bp + inclusive) |
| `POST` | `/v1/tax-categories` | Create tax category (`catalog.manage`) |
| `GET` | `/v1/categories` | Product categories |
| `POST` | `/v1/categories` | Create category (`catalog.manage`) |
| `GET` | `/v1/pricing/resolve` | Resolve price for `productId`/`quantity` `asOf` a timestamp (dated promotions) |
| `GET` | `/v1/inventory/balances` | Derived on-hand projection |
| `GET` | `/v1/inventory/movements` | Append-only stock movement ledger |
| `GET` | `/v1/config/snapshot` | Offline config snapshot |
| `POST` | `/v1/sync/push` | Bounded command batch |
| `GET` | `/v1/sync/pull` | Ordered deltas + cursor |
| `GET` | `/v1/sync/status` | Diagnostics |
| `POST` | `/v1/sync/conflicts/:id/resolve` | Audited resolution |
| `GET` | `/v1/licensing/status` | Edition + entitlements |
| `GET` | `/v1/licensing/entitlements` | Entitlement ids |
| `POST` | `/v1/licensing/requests` | Export renewal request (`license.manage`) |
| `POST` | `/v1/licensing/packages/issue` | Issue signed JWS package (`license.manage`) |
| `POST` | `/v1/licensing/packages/:id/ack` | Acknowledge after re-verify (`license.manage`) |
| `POST` | `/v1/licensing/packages/verify` | Verify a package server-side |

Generated OpenAPI emission and typed clients are a Phase 2/11 task; this file tracks the contract until
then.
