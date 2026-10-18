-- 0004_fifo_valuation.sql
-- Inventory valuation moves from weighted average to FIFO with valuation layers (ADR 0009).
-- Nothing historical is rewritten: layers are derived from receipts from this migration onward,
-- and the existing append-only movements/balances are untouched apart from the new cost column.

-- Derived FIFO cost of an outbound movement. Set once, in the same transaction that records the
-- movement; the quantity/reason fields of a movement remain immutable facts.
ALTER TABLE inventory_movements ADD COLUMN cogs_minor bigint;

-- One row per receipt tranche. FIFO consumes the oldest `received_at` layer with quantity left.
CREATE TABLE inventory_valuation_layers (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  branch_id           uuid NOT NULL REFERENCES branches(id),
  location_id         uuid NOT NULL REFERENCES stock_locations(id),
  product_id          uuid NOT NULL REFERENCES products(id),
  source_movement_id  uuid REFERENCES inventory_movements(id),
  unit_cost_minor     bigint NOT NULL,
  quantity_received   numeric(18,3) NOT NULL,
  quantity_remaining  numeric(18,3) NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity_received > 0),
  CHECK (quantity_remaining >= 0)
);

-- Partial index: only open layers matter for FIFO consumption and valuation.
CREATE INDEX inventory_valuation_layers_fifo_idx
  ON inventory_valuation_layers (tenant_id, branch_id, location_id, product_id, received_at, id)
  WHERE quantity_remaining > 0;

-- Traceability: exactly which layers paid for which outbound movement, and how much.
CREATE TABLE inventory_cost_allocations (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  movement_id     uuid NOT NULL REFERENCES inventory_movements(id),
  layer_id        uuid NOT NULL REFERENCES inventory_valuation_layers(id),
  quantity        numeric(18,3) NOT NULL,
  unit_cost_minor bigint NOT NULL,
  amount_minor    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity > 0)
);

CREATE INDEX inventory_cost_allocations_movement_idx ON inventory_cost_allocations (tenant_id, movement_id);
