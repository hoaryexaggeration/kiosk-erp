-- Cross-branch stock transfers (item 4.7, ADR 0008).
--
-- A transfer is ONE document written by TWO branches: the source dispatches, the destination
-- receives, and between those two moments the goods belong to neither branch. That is the whole
-- design — "stock is in exactly one branch or in transit, never both" — so the document carries the
-- quantities on both sides and the ledger only ever learns about branch-local facts:
--
--   dispatch  ->  a NEGATIVE movement at the source (its layers are consumed, the cost travels)
--   receive   ->  a POSITIVE movement at the destination, opening a layer at that carried cost
--
-- `quantity_received` may be smaller than `quantity_dispatched` (a shortage counted at the door);
-- the difference is NOT a movement, because those units are already out of the source. It stays on
-- the document as a discrepancy until the receiver says who approved it — which is why receiving
-- short is a state (`discrepancy`), not a silently accepted count.

CREATE TABLE stock_transfers (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  -- Human reference for two branches reconciling over the phone: TRF-0001, from a tenant-wide
  -- numbering series (numbering_series with branch_id IS NULL).
  reference      text NOT NULL,
  from_branch_id uuid NOT NULL REFERENCES branches(id),
  to_branch_id   uuid NOT NULL REFERENCES branches(id),
  -- dispatched  : goods left the source and are in transit
  -- received    : counted at the destination exactly as sent
  -- discrepancy : counted at the destination with an approved shortage
  status         text NOT NULL CHECK (status IN ('dispatched', 'received', 'discrepancy')),
  note           text,
  dispatched_by  uuid,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  received_by    uuid,
  received_at    timestamptz,
  -- Supervisor who authorised a shortage (and any forced dispatch); a note is what makes it a
  -- decision rather than a typo, matching the negative-adjustment override (ADR 0009).
  approved_by    uuid,
  approval_note  text,
  line_count     integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A branch is never its own destination, and a document cannot be in transit and received at once.
  CONSTRAINT stock_transfers_distinct_branches CHECK (from_branch_id <> to_branch_id),
  CONSTRAINT stock_transfers_received_state CHECK (
    (status = 'dispatched' AND received_at IS NULL)
    OR (status <> 'dispatched' AND received_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX stock_transfers_reference_uidx ON stock_transfers(tenant_id, reference);
CREATE INDEX stock_transfers_from_idx ON stock_transfers(tenant_id, from_branch_id, dispatched_at DESC);
CREATE INDEX stock_transfers_to_idx ON stock_transfers(tenant_id, to_branch_id, dispatched_at DESC);

CREATE TABLE stock_transfer_lines (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  transfer_id         uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES products(id),
  -- Held in the product's base unit like every other stock quantity (item 4.6); the pair below
  -- remembers the paperwork, and is only written when the two differed.
  unit                text NOT NULL,
  entered_unit        text,
  entered_quantity    numeric(18,3),
  quantity_dispatched numeric(18,3) NOT NULL CHECK (quantity_dispatched > 0),
  -- NULL until the destination counts this line; 0 is a real count (nothing of this arrived).
  quantity_received   numeric(18,3),
  -- Cost per BASE unit that travelled, stamped at dispatch from the source's FIFO layers so the
  -- destination values what it received at what the source was carrying (ADR 0009).
  unit_cost_minor     bigint NOT NULL DEFAULT 0,
  UNIQUE (transfer_id, product_id)
);
CREATE INDEX stock_transfer_lines_transfer_idx ON stock_transfer_lines(transfer_id);
CREATE INDEX stock_transfer_lines_product_idx ON stock_transfer_lines(tenant_id, product_id);

-- The transfer reference series is TENANT-wide (branch_id IS NULL). The existing
-- UNIQUE (tenant_id, branch_id, name) cannot hold two NULLs apart, so without this partial index
-- two branches could each create a "transfers" series and hand out the same number twice.
CREATE UNIQUE INDEX numbering_series_tenant_wide_uidx
  ON numbering_series(tenant_id, name) WHERE branch_id IS NULL;
