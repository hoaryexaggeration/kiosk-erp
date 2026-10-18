# Operations runbooks

Phase-appropriate operational procedures. These are living documents; each phase adds detail.

## Backup & restore (§10)

- **Cloud (PostgreSQL):** nightly automated backup + periodic restore test. Practice: bring up a fresh
  Postgres from the latest dump, run migrations, assert row counts on `sales`, `journal_lines`.
- **Mobile:** Room/SQLite integrity check on open; safe migrations; warn the user if local-only data
  has not synced. Never make uninstall the default remedy (§16 phone protocol).
- **Restore drill command:** `npm run db:up && npm --workspace apps/api run migration:run`.

## Oldest-unsynced monitoring (§10)

Watch `oldest pending age` from `GET /v1/sync/status` per device. Escalate before local storage fills
or a device is offline beyond policy. Alert thresholds (pilot defaults): 1h warn, 8h escalate, 24h page.

## Sync conflict runbook (§6)

1. Open exception centre → filter `conflict` / `review_required`.
2. Read the `conflictId`, aggregate type, and reason. **Never** dismiss — resolutions are audited.
3. For `CREDIT_EXCEEDED` / `NEGATIVE_STOCK`: preserve the movement, allocate to a supervisor, decide
   the business outcome (accept + exception, or compensating movement). History is never deleted.
4. Record the resolution via `POST /v1/sync/conflicts/:id/resolve` with actor + reason.

## Device loss / revocation (§10)

1. Revoke on the server (`/v1/devices/revoke`) → device cannot authenticate on reconnect.
2. Note that offline revocation is not instantaneous; reduce exposure with short offline validity.
3. Re-enroll the replacement device; the license device binding may need a transfer (ADR 0003 / §13).

## Deployment / migration rollback (§15 Phase 12)

- Migrations are forward-only numbered `.sql` files applied in a transaction.
- Rollback strategy is **forward-fix** by default; keep the previous app version compatible with the
  new schema (expand → migrate → contract) for at least one release.
