-- 0005_units_brands.sql
-- Item 4.6: the vocabulary stock is expressed in (`units_of_measure`), the pack sizes a shop
-- really buys in (`unit_conversions`), and the brand a product belongs to (`brands`).
--
-- Stock is still held ONLY in a product's base unit (`products.unit`); these tables never store a
-- quantity. A conversion is a fact about ONE product — a crate of soda is 24 bottles while a crate
-- of water is 12 — so it hangs off the product rather than being a global guess, and it is stored
-- relative to the base so converting needs no graph search.

-- What a unit MEANS, which decides what may be written into the ledger: a counted base must stay
-- a whole number (you cannot receive 0.2 of a bottle), a weighed or measured one may be fractional.
CREATE TABLE units_of_measure (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,   -- machine-readable: 'ea', 'kg', 'crate'
  name       text NOT NULL,   -- what the operator reads: 'Each', 'Kilogram', 'Crate'
  kind       text NOT NULL DEFAULT 'count',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(code) BETWEEN 1 AND 16),
  CHECK (char_length(name) BETWEEN 1 AND 60),
  CHECK (kind IN ('count', 'weight', 'volume'))
);
-- Case-insensitive: a shopkeeper typing "EA" and "ea" means one unit, not two.
CREATE UNIQUE INDEX units_of_measure_tenant_code_uidx ON units_of_measure (tenant_id, lower(code));

-- `1 <unit> = <factor> <product.unit>`. Product-scoped, per-product factor, never applied to a
-- different product's stock. `unit` is deliberately NOT a foreign key to units_of_measure: the
-- conversion stores a code, and the API refuses to write one the catalogue does not know.
CREATE TABLE unit_conversions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit       text NOT NULL,
  factor     numeric(18,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (factor > 0),
  CHECK (char_length(unit) BETWEEN 1 AND 16)
);
CREATE UNIQUE INDEX unit_conversions_product_unit_uidx
  ON unit_conversions (tenant_id, product_id, lower(unit));
CREATE INDEX unit_conversions_product_idx ON unit_conversions (tenant_id, product_id);

-- Brands are a product-master attribute (§3.C). Named, not deleted: historical receipts may name
-- one, and an unused brand costs nothing to keep.
CREATE TABLE brands (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX brands_tenant_name_uidx ON brands (tenant_id, lower(name));

ALTER TABLE products ADD COLUMN brand_id uuid REFERENCES brands(id);
CREATE INDEX products_brand_idx ON products (tenant_id, brand_id) WHERE brand_id IS NOT NULL;

-- What the paperwork said, when it was not the unit stock is held in. `unit` on a movement is
-- always the product's base unit — that is what "one stock ledger" means — so these two remember
-- the pack a quantity arrived as and let history say "10 crate -> +240 ea" instead of a number no
-- GRN contains. They are NULL for every movement that was already in the base unit, which is why
-- the pair is all-or-nothing.
ALTER TABLE inventory_movements ADD COLUMN entered_unit text;
ALTER TABLE inventory_movements ADD COLUMN entered_quantity numeric(18,3);
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_entered_pair_chk
  CHECK ((entered_unit IS NULL) = (entered_quantity IS NULL));
