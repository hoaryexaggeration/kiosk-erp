-- Price lists: branch-specific and scheduled prices, plus price-change history (item 4.11, D5).
--
-- §3.C lists "price lists, branch-specific prices … scheduled prices" and line 144 demands
-- "price change history … avoid letting a stale mobile copy silently overwrite a newer server
-- price". The shared catalogue keeps ONE base price; a price LIST is a dated, optionally
-- branch-scoped override of it — one mechanism that answers both "West sells oil at 330" and
-- "from Friday, sugar is 190" without inventing a second pricing system.
--
-- `branch_id IS NULL` is the tenant-wide list ("every shelf"); a branch id narrows it to that
-- shelf. Most specific scope wins at resolution, then the latest `valid_from` — a scheduled row
-- takes over the moment its window opens, on every device, purely from cached data (§1.6: the
-- till prices itself offline and never waits for a push).
--
-- `price_version` on products exists so a sale snapshot can say WHICH price it charged: it moves
-- only when the base price moves, not on every product edit, so a description typo cannot make a
-- device's price look stale. The stale check at posting time compares AMOUNTS (charged vs
-- policy-for-that-branch-at-sale-time) and only warns — a completed receipt is never silently
-- re-priced (§13, architecture line 394).
ALTER TABLE products
  ADD COLUMN price_version integer NOT NULL DEFAULT 1;

CREATE TABLE product_price_overrides (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  -- NULL = every branch of the tenant; otherwise exactly this shelf (ADR 0008: prices are one of
  -- the few per-branch facts — the catalogue itself stays shared).
  branch_id    uuid REFERENCES branches(id),
  price_minor  bigint NOT NULL CHECK (price_minor >= 0),
  valid_from   timestamptz NOT NULL,
  -- NULL = open-ended: "from Friday until I say otherwise".
  valid_to     timestamptz,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX product_price_overrides_tenant_product ON product_price_overrides(tenant_id, product_id, valid_from DESC);

-- Every base-price edit and every override write lands here, in the same transaction as the write
-- itself: history that can be added to afterwards is history nobody trusts.
CREATE TABLE price_change_history (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  branch_id       uuid REFERENCES branches(id),
  old_price_minor bigint,
  new_price_minor bigint NOT NULL CHECK (new_price_minor >= 0),
  -- 'edit' (catalogue form/API), 'import' (bulk file), 'override' (list row created or changed),
  -- 'override_removed' (list row deleted).
  source          text NOT NULL,
  actor_id        uuid REFERENCES users(id),
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX price_change_history_tenant_product ON price_change_history(tenant_id, product_id, changed_at DESC);
