# Posting matrix (DRAFT — accountant sign-off required)

**Status:** DRAFT. Not authoritative until signed by a qualified accountant (§7, §15 Phase 8).
Every posted journal MUST balance: Σ debit = Σ credit. Posted journals are immutable; corrections use
reversal/correcting entries with reason, actor, timestamp and link to the original (§7).

Accounts referenced below are logical; the concrete chart of accounts is configured per tenant.

| Event | Debit | Credit | Notes |
|---|---|---|---|
| Cash sale | Cash / Tender clearing | Sales revenue + Tax liability | Revenue/tax split per approved tax treatment |
| Card / M-PESA sale (verified) | Payment clearing | Sales revenue + Tax liability | Only after provider-confirmed status |
| Cost of sold stock | Cost of goods sold | Inventory asset | Weighted average (ADR 0006) |
| Credit sale | Accounts receivable | Sales revenue + Tax liability | Links to invoice; customer balance derived |
| Debtor payment (cash) | Cash | Accounts receivable | Allocation may be partial/unapplied |
| Supplier bill for stock | Inventory (or expense) + eligible tax | Accounts payable | Match to PO/GRN |
| Supplier payment | Accounts payable | Cash / bank / payment clearing | Reconcile vs approved payment |
| Stock loss / write-off | Inventory loss/expense | Inventory asset | Reason + approver + movement mandatory |
| Customer return/refund | Sales returns + tax reversal; Inventory (if resalable) | Cash/refund clearing and/or customer credit | Reference original sale where possible |
| Stock adjustment (increase) | Inventory asset | Inventory adjustment gain | Reason + approver mandatory |
| Expense / paid-out | Expense account | Cash | Approval threshold per policy |

## Invariants enforced in code and tests (Phase 8)

- Journal balances per currency (Σ debit = Σ credit).
- AR subledger total = AR control account; AP likewise; inventory valuation = inventory control.
- One canonical financial effect per source document (`source_type`,`source_id` unique per rule).
- Sale/payment/stock ids are stable UUIDs; local numbers never recycled (ADR 0006).
- Reversals reference the original and do not mutate it.

## Subledger → control reconciliation

| Subledger | Control account |
|---|---|
| Customer AR balances | Accounts Receivable |
| Supplier AP balances | Accounts Payable |
| Inventory valuation layers | Inventory asset |
| Cash sessions / movements | Cash |
| Bank statement matches | Bank |
