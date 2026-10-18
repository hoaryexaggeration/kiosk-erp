-- 0003_phase4_catalogue_inventory.sql
-- Phase 4: catalogue/tax editing, price resolution with dated promotions, and inventory
-- movements that can be approved. Money stays integer minor units; nothing here mutates
-- historical facts — it only adds tables/columns.

-- A promotion resolves to a unit price. `value` is basis points for percent_off,
-- minor units for amount_off / fixed_price. Dated windows make price resolution a
-- function of `asOf` (never of wall-clock drift on a device).
CREATE TABLE promotions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  kind          text NOT NULL,      -- percent_off | amount_off | fixed_price
  value         integer NOT NULL,   -- bp (percent) or minor units (amount/fixed)
  product_id    uuid REFERENCES products(id) ON DELETE CASCADE,
  category_id   uuid REFERENCES categories(id) ON DELETE CASCADE,
  starts_at     timestamptz,
  ends_at       timestamptz,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('percent_off', 'amount_off', 'fixed_price')),
  CHECK (product_id IS NOT NULL OR category_id IS NOT NULL),
  CHECK (value >= 0)
);
CREATE INDEX promotions_tenant_idx ON promotions(tenant_id) WHERE is_active;
CREATE INDEX promotions_product_idx ON promotions(product_id) WHERE is_active;

-- Approvals on inventory movements (e.g. shrinkage sign-off) without mutating the movement fact.
ALTER TABLE inventory_movements ADD COLUMN approved_by uuid REFERENCES users(id);
ALTER TABLE inventory_movements ADD COLUMN approval_note text;
