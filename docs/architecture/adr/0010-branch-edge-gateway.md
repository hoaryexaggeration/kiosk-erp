# ADR 0010 — Branch edge gateway and the local-network model

- **Status:** Accepted — **amends ADR 0004** (supersedes its "one offline-authoritative till" MVP scope)
- **Date:** 2026-10-19
- **Phase:** 0 decision, built across 5–11
- **Owner decision:** §18.1/§18.2 — "multiple tills via a branch edge gateway"; §18.2 — "total
  isolation, no local network", reconciled as: *the gateway provides the local network*

## Context

The architecture describes three models for multiple offline devices (§6): one offline-authoritative
till, allocated stock partitions, or a **branch edge gateway** — and explicitly scopes the gateway as
a later component (§17: "keep the edge gateway out of MVP unless discovery proves it launch-critical").

The owner has proven it launch-critical: **multiple branches from day one**, **multiple tills per
branch** selling offline, and **total isolation** where even the shop's internet may be down. The
owner also chose, when the contradiction was put to them directly, that *the gateway provides its own
in-store network* — so "total isolation" means **no WAN**, not "no radio at all".

## Decision

1. **The gateway is the branch's local authority.** An always-on in-store device (a small mini-PC or
   Android box) provides the branch's local network — its own Wi-Fi/hotspot or switch — and hosts:
   - the **local stock and sales ledger** for the branch, so tills never need to reason about each
     other's offline sales;
   - **till coordination**, i.e. the single serialisation point for stock-reducing transactions across
     the branch when the WAN is down;
   - **durable local storage and backups** of everything created while offline, so nothing depends on
     a single phone surviving;
   - its **own cloud sync**, independent of any till.
2. **Tills talk to the gateway, not to each other.** A till sends its provisional commands to the
   gateway, which is canonical for the branch while offline and forwards to the cloud when the WAN
   returns. Tills keep their own local database for *browsing and drafting*, so a till can still open
   a cached catalogue and a held cart if the gateway is briefly unreachable.
3. **The cloud remains the tenant-wide authority.** Cross-branch stock, pricing, licensing and the
   owner's consolidated view live in the cloud (`apps/api`). The gateway is authoritative for its
   branch only.
4. **Total-isolation guarantees for every till.** No till may require the WAN to sell, print or
   reconcile. Bluetooth printing and camera scanning are peer links and are unaffected. A till that
   cannot reach its gateway degrades to browse/draft and says so plainly in the UI.
5. **Degraded mode.** If the gateway is down, the branch's tills do not silently become independent
   competing writers (the failure mode §6 prohibits). They enter an explicit degraded mode: sales are
   refused with a clear message, or — if the owner enables it per branch — exactly one designated till
   becomes the temporary offline author.

## Consequences

- **Positive:** from day one the branch can keep selling through a WAN outage with correct stock and
  one reconcilable ledger; the gateway is also the natural home for backups, printing spooling and
  later eTIMS buffering.
- **Negative / risk (§17):** a new always-on component to install, secure, back up, upgrade and
  recover — it is a separately tested deliverable with its own acceptance suite, not an afterthought.
  It also adds an identity/trust record (gateway ↔ cloud, till ↔ gateway) to the device model.
- **Deferred but required:** the gateway build itself, its upgrade/recovery runbook, and the
  till↔gateway protocol. Tracked in `master-plan.md`: items added to phases 5, 6, 9 and 11, with the
  licence/device records in phases 2–3.

## Compliance check

Implements §6 option 3 (branch edge gateway) and §18.1/§18.2, superseding the narrower MVP scope of
ADR 0004. Does not violate §6: the gateway is the explicit, tested serialisation point that §6
requires, rather than an implicit assumption that disconnected apps share a register.
