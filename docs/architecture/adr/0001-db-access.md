# ADR 0001 — Database access layer

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 1 / 2
- **Supersedes:** none

## Context

The architecture mandates PostgreSQL, a migration workflow, single-transaction local/server writes
(the sale + lines + tender + stock movement + audit + outbox must commit atomically, §1.6 rule 2),
append-only money/stock ledgers (§1.6 rule 4), DB constraints that are authoritative for idempotency
and tenant scoping (§6, §8), and reconcilable subledgers that require non-trivial analytical SQL
(AR/AP aging, trial balance, stock valuation) (§7).

The document names NestJS and PostgreSQL but **no ORM**.

## Options considered

1. **TypeORM** — idiomatic with NestJS, fast to start.
2. **Prisma** — great DX and types, own query engine and migration model.
3. **Kysely + canonical SQL migrations** — type-safe SQL builder, no runtime magic.
4. **Raw `pg` + hand-written repositories** — maximum control, most boilerplate.

## Decision

Use **SQL migration files as the canonical schema** (plain, numbered `.sql`, applied by a small
transactional runner) and **Kysely** for type-safe query composition, with raw `pg` escape hatches.

Reasons:

- The hard parts of this system are explicit SQL (ledgers, aging, projections, cursor deltas). An
  entity mapper adds drift risk and is bypassed for the difficult ~30% anyway.
- The architecture treats DB constraints as security ("filtering only in the UI is not security",
  §8). Keeping SQL visible makes unique/foreign/check constraints first-class review artifacts.
- Financial integrity is easier to review when the transaction boundary is explicit
  (`BEGIN … COMMIT`) rather than implicit behind ORM session semantics.
- Migrations remain portable to any Postgres tool later; Kysely adds no schema ownership.

## Consequences

- **Positive:** schema and constraints are reviewable; no ORM↔DB drift; queries are portable.
- **Negative:** more boilerplate, no lazy relations; the team must write joins by hand.
- **Mitigation:** provide repository helper patterns and typed row interfaces in `apps/api/src/db`.

## Compliance check

Aligns with §1 (street stack), §7 (integrity), §8 (data model & constraints), §15 Phase 2
(migration workflow). No architectural rule violated.
