# Phase 0 — Discovery & MVP boundary (Checkpoint 0 artifact)

**Status:** Draft for owner sign-off. No POS implementation proceeds until this is approved (§15 Phase 0).
**Owner of record:** (to be signed) · **Date:** 2026-10-18

This file records the Phase 0 decisions so implementation has a single source of truth. Items marked
**⚠ needs input** are assumptions I have made so the build can proceed; they must be confirmed by the
owner / accountant before the relevant phase gate.

## 1. First shop profile

| Attribute | Value (assumption) |
|---|---|
| Business type | Single kiosk / minimarket |
| Branches | 1 |
| Tills | 1 offline-authoritative till (ADR 0004); additional devices browse-only |
| SKUs | ~500–2,000 |
| Sales/day | ~200–500 |
| Cashiers | 1–3 |
| Offline isolation | **WAN outage only** (local Wi-Fi may exist); no full isolation assumed in MVP ⚠ |

## 2. Workflow map (as-is → target)

1. **Sale** — open shift → scan/search → cart → discount (permissioned) → tender (cash first) →
   commit → local receipt → queued sync → server posts sale + stock + ledger.
2. **Cash shift** — open float → cash in/out, paid-outs, safe drop → count → variance → supervisor
   sign-off → close.
3. **Return/refund** — find original sale → select lines/qty → supervisor override → refund tender →
   stock movement (resalable) → server credit note.
4. **Stock receipt (GRN)** — supplier → PO or controlled receiving → quantities → device event →
   server matches PO/GRN.
5. **Debtor payment** — find customer → recorded tender → queued → server allocation, reconciled.
6. **Supplier bill & payment** — capture bill → match PO/GRN → approval → payment (bank/M-Pesa needs
   connectivity).
7. **Day-end close** — shift close → local session report → server-reconciled close.

## 3. Module prioritisation (MVP vs later)

| In MVP (Phases 2–12) | Deferred (post-Phase 12) |
|---|---|
| Platform/admin, POS, catalogue/pricing, inventory, customers/AR, suppliers/AP, accounting core, tax/eTIMS adapter, owner dashboard, sync, licensing | Payroll, advanced loyalty, e-commerce, fixed assets, manufacturing, multi-currency, branch edge gateway, iOS (Phase 13) |

## 4. Permission matrix (baseline)

| Action | Cashier | Supervisor | Manager | Owner/Admin |
|---|---|---|---|---|
| Sell / tender cash | ✅ | ✅ | ✅ | ✅ |
| Apply line/order discount | ❌ | ✅ (cap %) | ✅ | ✅ |
| Price override | ❌ | ✅ | ✅ | ✅ |
| Void before finalise | ❌ | ✅ | ✅ | ✅ |
| Refund/return | ❌ | ✅ | ✅ | ✅ |
| Stock adjustment | ❌ | ❌ | ✅ | ✅ |
| Credit sale over limit | ❌ | ✅ (override, audited) | ✅ | ✅ |
| Shift close variance approval | ❌ | ✅ | ✅ | ✅ |
| User/role/device admin | ❌ | ❌ | ❌ | ✅ |
| Journal reversal | ❌ | ❌ | ❌ | ✅ (restricted) |
| License import/export | ❌ | ❌ | ❌ | ✅ |

Permission ids are stable strings (`pos.sale.create`, `pos.discount.apply`, `inventory.adjust`,
`ar.credit.override`, `cash.shift.close`, `admin.user.manage`, `accounting.journal.reverse`,
`license.manage`). Enforced **server-side**; the UI only hides.

## 5. Offline capability matrix

Taken verbatim from §2 of the architecture and adopted as the MVP contract. Key MVP positions:

- Cash sale, receipt (provisional), local stock projection, debtor receipt in cash: **available**.
- Live M-PESA STK / card authorization, eTIMS confirmation, owner live view of unsent events:
  **not available offline** — shown as pending/unverified.
- Manual M-PESA reference: stored as **unverified/pending reconciliation** only.

## 6. Regulatory & accounting sign-off items

- ⚠ KRA eTIMS onboarding path (eTIMS Client / VSCU / OSCU) — **must be confirmed with KRA/integrator** before Phase 10.
- ⚠ Chart of accounts, tax treatment, fiscal year, opening balances — **accountant sign-off** before Phase 8 (`docs/accounting/posting-matrix.md`).
- ✔ Cost method: **FIFO with valuation layers** confirmed by the owner (§18.5, 19 Oct 2026) — ADR 0009.
- ⚠ Kenya DPA 2019 / ODPC obligations — legal review (`docs/compliance/`).

## 7. Commercial model (adopted)

Three-part offer (§13.1): Perpetual Offline Core (one-time) · Annual Maintenance & Upgrades
(optional) · Connected Services (subscription). Offline renewal via request-file/QR ↔ signed `.lic`
package (JWS, ADR 0003). Grace period pilot default 14 days. Core POS never gated on a network
license call.

## 8. MVP explicit boundaries

- One branch, one offline-authoritative till.
- Cash-first tendering; recorded/credit tender enabled under strict policy.
- Server-side canonical accounting posting on sync (no offline GL).
- No shared-stock promise across disconnected devices.
- Payroll, e-commerce, loyalty, edge gateway excluded.

## 9. Hardware baseline ⚠

Android baseline, receipt printer, barcode scanner and cash-drawer specifics are **not yet fixed**.
Camera scanning is the MVP fallback; printer support is an output adapter and must never block or
duplicate a sale. Exact models go into the Phase 5 pilot test, not a marketing assumption.

## Checkpoint 0 exit criteria

- [ ] Owner signs the workflow map, MVP boundaries and commercial model.
- [ ] Accountant engaged for chart/posting matrix.
- [ ] eTIMS path confirmed.
- [ ] APK Gate 0: `retail-erp-p00.apk` installs, launches, shows version/environment, no crash.
