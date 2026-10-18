# ADR 0008 — Multi-branch from day one, shared catalogue, cross-branch transfers

- **Status:** Accepted
- **Date:** 2026-10-19
- **Phase:** 0 decision, enforced from 4 onward
- **Owner decision:** §18.1 — "multiple branches from day one"; branch model — "shared catalogue +
  cross-branch transfers"

## Context

The architecture anticipates multi-branch retails (§3.A, §4 "major boundaries") but a single-branch
MVP is the common reading of §15. The owner needs several shops on the first release, sharing one
catalogue and moving stock between branches.

This change is structural: every table, query, sync payload and report must be branch-scoped from the
beginning. Retrofitting branch scoping onto an established schema is exactly the kind of migration the
architecture warns against (§7), so it is decided and enforced now.

## Decision

1. **One tenant, many branches.** `branches` belong to a `tenants` row; products, suppliers, the chart
   of accounts and licensing are **tenant-wide**. Stock, sales, cash sessions, prices that are set
   per branch, and numbering series are **branch-scoped**.
2. **Shared catalogue.** A product created in one branch is visible to all branches. `products`,
   `barcodes`, `categories`, `tax_categories` and `promotions` carry `tenant_id`; per-branch pricing
   is expressed as a *branch price* row (Phase 4, item 4.11), not as a duplicate product.
3. **Cross-branch transfers.** Moving stock between branches uses a transfer document with explicit
   **dispatch** and **receipt** states and a discrepancy state, always as movements (never as a
   quantity edit). Stock is in one branch or in transit — never counted in both.
4. **Consolidated owner view.** The owner dashboard (§3.I, Phase 9) reports per branch and consolidated,
   with branch selection rather than separate logins for each shop.
5. **Branch scoping is enforced, not conventional.** Every device, sync command and query carries
   `branch_id`; the server rejects a command whose branch does not match the authenticated device's
   branch (already enforced for device mismatch in `sync.service.ts`). Cross-branch reads are allowed
   only for roles that hold the consolidated-reporting permission.
6. **Gateway interaction.** Each branch has at most one edge gateway (ADR 0010). A transfer between
   branches is a cloud-level document (in transit over the WAN); a till never writes another branch's
   ledger directly.

## Consequences

- **Positive:** the schema and sync envelope are correct for growth from the first release; the owner's
  view is genuinely consolidated; stock in transit is tracked rather than guessed.
- **Negative:** more scoping discipline in every module and test; per-branch price/list management is
  extra work in Phase 4; branch administration becomes a real Phase 2/3 surface (create branch, assign
  devices, set numbering series).

## Compliance check

Implements §3.A/§3.D and §18.1. Reinforces §7: transfers and branch movement are append-only movements,
and no money or quantity is last-write-wins.
