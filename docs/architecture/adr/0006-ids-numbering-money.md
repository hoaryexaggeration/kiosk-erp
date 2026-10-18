# ADR 0006 — IDs, numbering and money precision

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 1

## Context

§9: "Use stable UUIDs for business IDs; do not depend on server-generated sequential primary keys for
offline creation." §7: "Never recycle a locally generated document ID"; store money as **integer minor
units** (KES cents) or a strictly defined fixed-precision decimal; "Do not use binary floating point
for money"; define rounding by currency, tax rule and line/document level. §1.6 rule 4: money/stock
movements are append-only facts.

## Decisions

1. **Identity:** every business entity id is a **UUIDv4 generated on the creating device** (client or
   server). Server tables use the same UUID as their primary key — no separate sequential PK is
   exposed to clients.
2. **Server ordering:** canonical event ordering uses a **server-assigned monotonic sequence**
   (`server_events.seq`, bigserial) — never client clocks (§6).
3. **Document numbering:** human-facing receipt/invoice numbers come from a **`NumberingSeries`** with
   a device/branch-scoped local provisional prefix (e.g. `LL-{branch}-{device}`) distinct from the
   server/tax number; a local number is **never recycled**. The canonical number attaches on
   acknowledgement.
4. **Money:** all monetary amounts are **integer minor units** (`*_minor`, integer). Rounding is
   applied at the **tax-rule level** and totalled per document; the policy lives in
   `packages/domain-fixtures` and is implemented identically in TypeScript and Kotlin.
5. **Cost method:** ~~weighted average for the MVP~~ **SUPERSEDED by ADR 0009** — inventory is valued
   **FIFO with valuation layers** (owner decision, §18.5). The money/precision rules above still stand
   unchanged; only the cost-flow assumption changed.

## Consequences

- **Positive:** offline-created records are globally unique and never collide; no float money errors.
- **Negative:** UUID keys are larger than bigints; number formatting needs a shared fixture suite.

## Compliance check

Implements §7, §9 and §1.6 rule 4. No rule violated.
