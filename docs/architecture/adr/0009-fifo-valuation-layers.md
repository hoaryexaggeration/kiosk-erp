# ADR 0009 — Inventory valuation: FIFO with valuation layers

- **Status:** Accepted — **supersedes the weighted-average cost method in ADR 0006 item 5**
- **Date:** 2026-10-19
- **Phase:** 1 decision, implemented in 4
- **Owner decision:** §18.5 — "FIFO with valuation layers"; §18.5 negative stock — "block sales;
  adjustments need a supervisor override"

## Context

ADR 0006 chose weighted average for the MVP and deferred FIFO. The owner has decided on FIFO,
primarily so that cost of goods sold and stock value track the actual purchase tranches (useful for
perishables and for purchase-price volatility). FIFO cannot be retro-fitted later without restating
history, so it is implemented now, before more data is posted.

Two properties had to be preserved regardless of the costing method:

1. §1.6 rule 4 / §7 — money and stock movements are **append-only facts**; server-side posting is
   canonical and a device's figure is provisional.
2. A cost method must be **derivable and auditable**: any figure on a report must be traceable to the
   transactions that produced it.

## Decision

1. **Layers, not averages.** A receipt opens a valuation layer:
   `inventory_valuation_layers(unit_cost_minor, quantity_received, quantity_remaining, received_at)`.
   An issue consumes the **oldest open layers first** and writes
   `inventory_cost_allocations(movement_id, layer_id, quantity, unit_cost_minor, amount_minor)`
   recording exactly which tranches paid and how much.
2. **COGS is derived, never stored as a mutable product figure.** The FIFO cost of an outbound
   movement is summed into `inventory_movements.cogs_minor`, filled inside the same transaction that
   records the movement. The quantity, reason and actor fields of a movement are never rewritten.
3. **Stock value** is the sum of open layers
   (`GET /v1/inventory/valuation`), exposed per product and branch. No stored total exists to drift.
4. **Receipts always open a layer.** When a line carries no explicit `unitCostMinor`, the product's
   last known purchase cost (`products.cost_minor`) is used, so incoming stock is never silently
   valued at zero. `products.cost_minor` is retained **only** as the latest known purchase cost for
   display and as that fallback — it is no longer a weighted average and is never used for COGS.
5. **Negative stock (owner decision):**
   - A sale that would take stock below zero is refused **at the till**, using the local projection.
   - The server never discards a synced fact. Because offline sales by independent tills cannot be
     pre-validated, a synced sale that outruns the layers is still recorded, its costable part is
     costed FIFO, and the shortfall raises `NEGATIVE_STOCK` **and** `UNCOSTED_STOCK` conflict cases
     for the owner to resolve. `NEGATIVE_STOCK` additionally prevents further sales of that item at
     the till until resolved.
   - A **negative adjustment requires a supervisor override** (`approvedBy` + `approvalNote`); without
     it the command is `rejected`/`OVERRIDE_REQUIRED` and nothing is written (validation precedes any
     write, so a partially applied adjustment can never commit). With an override it is applied and
     returns `review_required`.
6. **Opening balances are movements.** Opening stock is imported as ordinary inbound movements that
   open layers — never as a bare `stock_balances.quantity` edit — so the balance, the ledger and the
   valuation agree from the first sale.

## Consequences

- **Positive:** COGS and stock value reflect real purchase tranches; every reported figure is
  traceable to allocations; the ledger agrees with the valuation by construction.
- **Negative:** more rows per issue (one allocation per consumed layer); a partial index
  (`quantity_remaining > 0`) and ordering by `(received_at, id)` keep consumption cheap; layer
  consumption must stay inside the posting transaction to avoid double consumption.
- **Deferred but required:** till-side blocking of a would-be-negative sale (Phase 5, item 5.x) and
  the stocktake/transfer flows that also consume layers (Phase 4 items 4.7/4.8).

## Compliance check

Implements §7 and §1.6 rule 4 (append-only facts, canonical server posting) with the owner's §18.5
choice. Supersedes only the cost-flow sentence of ADR 0006; its identity, numbering and money
decisions are unaffected.
