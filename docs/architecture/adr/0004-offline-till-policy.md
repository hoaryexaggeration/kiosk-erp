# ADR 0004 — Multi-device offline policy (MVP)

- **Status:** **Superseded in scope by ADR 0010** (branch edge gateway). Retained for the reasoning.
- **Date:** 2026-10-18 (amended 2026-10-19)
- **Phase:** 0 decision, enforced in 4–5

> **Amendment (2026-10-19).** The owner's §18 answers chose multiple branches from day one, multiple
> tills per branch and a **branch edge gateway** — i.e. option 3 below, previously scoped out of the
> MVP. ADR 0010 now governs the multi-device policy. This ADR's warning still holds and is the reason
> the gateway (not "trust the phones") is the chosen answer: independent devices must never be assumed
> to share a register.

## Context

Independent phones do not share local stock. §6 ("One store, multiple offline devices") requires the
rollout to **explicitly** pick one of: (1) one offline-authoritative till per branch, (2) allocated
stock / till partitions, or (3) a branch edge gateway (later). Silently assuming two disconnected
apps form a shared register is prohibited.

## Decision

**MVP = option 1: one offline-authoritative till per branch.** Additional devices may authenticate,
browse cached data and create *draft* documents, but only the designated offline-authoritative
device accepts offline stock-reducing transactions. The designation is a server-issued flag on the
device record and is surfaced in the app UI.

## Consequences

- **Positive:** simplest correct model; avoids misleading stock availability; no distributed stock math.
- **Negative:** a second till cannot sell during a WAN outage.
- **Migration path:** allocated-stock partitions (option 2) then an edge gateway (option 3) can be
  added later as separately tested components; option 3 is out of MVP scope (§3, §15).

## Compliance check

Directly implements §6 and the §18 decision item on offline isolation. No rule violated.
