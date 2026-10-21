# Price lists, scheduled prices and price history (item 4.11)

§3.C lists "price lists, branch-specific prices … scheduled prices" and demands "price change
history … avoid letting a stale mobile copy silently overwrite a newer server price". The §18
decision register makes **per-branch and scheduled price lists** part of the MVP (D5);
customer-specific and wholesale prices ride along with customers in Phase 7.

## One mechanism, two questions

The shared catalogue keeps ONE base price (`products.price_minor`). A **price list** is a dated,
optionally branch-scoped override of it (`product_price_overrides`, migration `0008`):

- **`branch_id` set** — that shelf prices differently: West sells the oil at 330 while Main keeps
  320 (the seeded demo).
- **`branch_id` null** — the tenant-wide list: every branch, once the window opens.
- **`valid_from` / `valid_to`** — a scheduled price takes over the moment its window opens
  (`valid_from` inclusive, `valid_to` exclusive, null = "from Friday until I say otherwise").

Resolution stacks: **base or the override in force** (most specific scope wins — a row naming the
branch beats the tenant-wide row, then the latest `valid_from`) → then a **promotion**, figured on
that effective list price, exactly as before. `GET /v1/pricing/resolve?productId=…&branchId=…
&asOf=…` shows the result and *where it came from* (`source: list | override | promotion`).

## The till prices itself offline

The override rows ride the same pull as the product (`price_overrides` on every product payload
and event), so a device computes the effective price for its own shelf and the current minute
from Room — a scheduled flip takes over with no push at all, which is the §1.6 promise kept for
pricing too. The device's `Pricing.effectiveListPrice` is a mirror of the server's sort order, so
the shelf and the cloud cannot disagree; the product editor shows the preview ("Today at West
Kiosk: 330.00 — base price 320.00") computed by the very function the till will use.

## Versioning, history, and the stale price

- `products.price_version` moves **only when the base price amount does** — never on a description
  edit — so a sale snapshot can say which price it charged without false alarms.
- Every price write lands in `price_change_history` **inside the same transaction as the write**:
  creates (`old = null`), catalogue edits (`edit`), bulk imports (`import`), list rows created or
  changed (`override`) and list rows deleted (`override_removed` — the shelf falls back to the
  base price, and that is a price change too). `GET /v1/pricing/history?productId=…` reads it back
  with the actor's name; the editor shows the last few entries.
- At posting time the server re-resolves each line **for that branch, as of the sale's own
  timestamp**, and compares the AMOUNT the till charged against the policy. Divergence is a
  `STALE_PRICE_SNAPSHOT` **warning** on the result — the receipt is never silently re-priced
  (§13). A device that edits a product with a stale `expectedVersion` still gets `409
  VERSION_MISMATCH`: overwriting a newer server price is impossible, not merely flagged.

## Managing rows

- **Per product** — the catalogue editor, *Price lists* section: the current rows (price, shelf,
  window, delete) and an add form (*Applies to* = All branches or a cached branch, price, start
  date `yyyy-MM-dd`, optional end). Editing a row in place is delete-and-re-add by design — a
  price list row is small, and every step leaves its own history entry.
- **API** — `POST/PATCH/DELETE /v1/pricing/overrides` (`catalog.manage`), validation mirroring
  prices elsewhere: whole shillings ≥ 0, `validTo` after `validFrom`, known branch or null.
- **Bulk** — a `reorder_point`-style column for price lists is NOT in the import file: a
  branch-scoped dated window is too dimensional for one CSV column. Imports remain the way to
  move BASE prices (and write `import` history as they do).

## Deliberately not here (later phases)

- **Customer-specific and wholesale/quantity-break prices** — Phase 7, where customers and
  suppliers exist; the resolver already takes `quantity` for exactly this hook.
- **Till snapshot attachment** — the till (Phase 5) will post `priceSnapshotVersion` with each
  line, closing the loop this item opens; the stale check and version exist now.
- **Approvals on price changes** — an owner-only permission gate stands today (`catalog.manage`);
  a formal approval workflow belongs with the eTIMS change-control story (Phase 8/10).

## Tests

`price-overrides.spec.ts` (8 tests): branch override vs base, scheduled window edge (a second
before vs at), branch beats tenant-wide, version moves only on the price, import history, the
override lifecycle including removal history, the stale-price warning on a real sale, and every
refusal (negative price, backwards window, unknown branch, cashier `403`) — part of the 171/171
across 15 suites against Docker Postgres.
