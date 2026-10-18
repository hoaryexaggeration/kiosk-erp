# Decision register — §18 owner decisions

The architecture (§18) requires twelve decisions to be approved by the owner "before full
implementation". This register records each answer, the date, and what it changes. Where an answer
overturns an earlier default, the affected document is amended and linked.

**Recorded:** 19 October 2026.

| # | §18 item | Owner decision | Effect |
|---|---|---|---|
| 1 | First release shape | **Multiple branches from day one** | Branch scoping is structural from Phase 4 onward — ADR 0008 |
| 2 | Offline isolation model | **Total isolation, no WAN.** The branch edge gateway supplies the in-store network | New MVP component — ADR 0010 (amends ADR 0004) |
| 3 | Devices that must sell offline | **Multiple tills per branch, coordinated by a branch edge gateway** | Gateway serialises branch sales while offline — ADR 0010 |
| 4 | Branch model | **Shared catalogue + cross-branch transfers with dispatch/receipt** | ADR 0008 |
| 5 | Inventory valuation | **FIFO with valuation layers** (supersedes weighted-average in ADR 0006) | Implemented in Phase 4 — ADR 0009 |
| 6 | Negative stock | **Block sales at the till; adjustments need a supervisor override + reason** | ADR 0009 item 5; till-side blocking is Phase 5 work |
| 7 | Product / transaction scale | **Medium shop / superette: ~2,000–20,000 SKUs, 500–2,000 sales/day** | Indexing, paging and bulk-import performance are design constraints, not later tuning |
| 8 | Receipt printer | **Not decided — width configurable.** ESC/POS encoder kept pure and testable | Printer adapter stays width-agnostic; model chosen before Phase 12 |
| 9 | Cash drawer | **Not decided** — cash is kept manually for now | Drawer kick stays an option on the printer adapter |
| 10 | eTIMS / tax labelling | **Local receipt + explicit pending-tax status now; eTIMS adapter in Phase 10** | Phase 5 receipt must carry a local/tax-invoice status field — ADR 0009-adjacent, Phase 5 item 5.10 |
| 11 | Licence model | **Perpetual offline core + annual maintenance + connected services** | Three entitlement tracks in the License screens; Phase 12 licence lifecycle pilot |
| 12 | MVP exclusions | **Exclude, but note for later — and leave room for the branch edge gateway** | Gateway is therefore *in* scope (ADR 0010); payroll, HR/rosters, advanced loyalty, e-commerce, manufacturing and multi-currency stay in the deferred ledger |

## Consequences to track

- **D25 (Phase 2 residual)** must now include **branch administration** (create a branch, numbering
  series per branch, device-to-branch assignment) and **gateway identity/trust records**.
- **D28 (Phase 3 residual)** must surface the **three licence tracks** (core / maintenance / connected
  services) and the renewal-request export.
- **Deferred items re-scoped:** cross-branch transfers are no longer a "later" nicety (ADR 0008 item 3)
  and move into Phase 4 (item 4.7). The branch edge gateway moves from "out of scope (§17)" into MVP as
  a separately tested deliverable (ADR 0010).
- **Pricing:** a shared catalogue plus medium scale makes **per-branch and scheduled price lists**
  (Phase 4 item 4.11) part of the MVP rather than optional.

## Still outstanding (block later phases, not current work)

- KRA eTIMS onboarding route and the accountant's sign-off on chart of accounts, tax treatment, cost
  method and close reports (Phase 8 / 10).
- Kenya Data Protection Act review (Phase 11).
- Hosting, backup and disaster-recovery expectations for the cloud and the per-branch gateway
  (Phase 2 residual / Phase 11).
- Phase 0 discovery sign-off.
