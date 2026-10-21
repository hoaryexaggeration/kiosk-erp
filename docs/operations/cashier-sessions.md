# Cashier sessions (the drawer) — item 5.2, D10

§15 Phase 5 requires "cashier session and role check" before a sale can exist, and Checkpoint 5
requires the whole flow to work in **airplane mode**. Those two pull in opposite directions unless
the session itself is an offline object — so the drawer is one.

## A drawer is a physical fact first, a server row second

A till cannot record a sale without an open session (exit criterion, D10). The session therefore
opens and closes **at the till, offline**, exactly like a sale:

- **Room** holds `cash_sessions` (migration `MIGRATION_7_8`): the till's own truth about its
  drawer, written in the same local-first style as everything else (§1.6 rule 1).
- The same facts travel to the server as **sync commands** — `CashSessionOpen` and
  `CashSessionClose` — pushed through the ordinary outbox with their own `commandId`, so an
  offline open survives a restart and a replay is a no-op.
- The **server referees when they land** (§1.6 rule 3): it owns the branch-wide view, derives the
  expected cash itself, and refuses what would break the day's accountability.

`GET /v1/cash/sessions/current?branchId=…` reads the drawer back for the till's boot state and any
back-office view; `GET /v1/cash/sessions/:id` reads one session including its close figures.

## One drawer per branch

`CashSessionOpen` refuses with `SESSION_ALREADY_OPEN` (a named `conflict` case, not a silent
pick) when the branch already has an open session: two drawers on one branch would make the day's
cash unreconcilable. Replaying the *same* open command is a `duplicate`; a *new* command naming a
session that already exists is accepted as a no-op — the aggregate is idempotent at both levels.

## The count is a reading; the books are derived

Closing takes what the till physically **counted** (`countedMinor`, required). The **expected**
figure is derived server-side, in `CashService.close`, from the float plus the cash the drawer
actually took (sales tendered in cash on that session — money tendered by card or M-PESA never
entered the drawer). `variance = counted − expected` is recorded with the actor in
`audit_events`, and both `cash.session.opened` and `cash.session.closed` land as server events.
Paid-outs, safe drops and refunds join the derivation when Phase 6 lands; the shape is already
honest without them.

## The gate on every sale

`SalePayloadSchema` now requires `cashSessionId`, and `SaleService.applySale` re-checks it before
anything is persisted:

| Situation | Result |
|---|---|
| No `cashSessionId` on the payload | `rejected` / `VALIDATION_ERROR` (schema) |
| Session unknown to the server | `rejected` / `SESSION_REQUIRED` — a retry cannot conjure it |
| Session belongs to another branch | `rejected` / `SESSION_BRANCH_MISMATCH` |
| Sale taken outside `[opened_at, closed_at]` | `rejected` / `SESSION_NOT_OPEN` |

The window is judged against the **sale's own clock** (`clientCreatedAt`), not posting time:
offline sales arrive long after the drawer closes, and the till enqueues its session command
before any sale, so a session that has not landed at all means a genuinely invalid sale. Every
refusal carries a human-readable `code` **and** `message` promoted to the push result, so the
Sync Centre names the fix rather than showing a bare "rejected" (§6). A refused sale writes
nothing — no row, no movement, no half-applied effect.

## The role gate, offline

The till caches the signed-in user's permission codes in `SessionStore` at sign-in (from
`GET /v1/auth/me`), so it can gate itself with the radio off:

- **No open drawer** → checkout is refused at the button: *"Open the drawer first — a sale cannot
  be recorded without one."*
- **No `pos.sale.create`** → *"This user cannot create sales (missing permission pos.sale.create)."*

The cached list decides only what the **cashier is told**; the server re-checks every permission
on the push path regardless (`REQUIRED_PERMISSION` maps `CashSessionOpen` → `cash.shift.open`,
`CashSessionClose` → `cash.shift.close`, `Sale` → `pos.sale.create`). A device token is never
proof of authority.

## Deliberately not here

- **Paid-outs, safe drops, cash-in/out, refunds in the expected derivation** — Phase 6 (cash
  accountability, end-of-day).
- **Split/multiple tenders per sale** — D15; the derivation counts cash-tendered sales, which is
  exact for the cash-only carts the till produces today.
- **Supervisor sign-off on close variance** — Phase 6.
- **A second till's drawer view in the back office** — the read endpoints exist; the UI is a
  later-phase dashboard concern.

## Tests

`cashier-session.spec.ts` (10 tests): open → current read (branch-scoped), a sale inside the
window, the schema refusal, `SESSION_REQUIRED`, before-open and after-close refusals, the
second-drawer conflict with its `conflict_cases` row, replay/no-op re-open, close with
server-derived expected/variance and its audit line, and the `cash.shift.open` role gate with a
no-roles user. `sync-sale.spec` and `price-overrides.spec` now open a drawer first — **181/181
across 16 suites** against Docker Postgres.
