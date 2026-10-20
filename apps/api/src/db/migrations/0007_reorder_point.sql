-- Low-stock thresholds (item 4.9, D8).
--
-- §15 Phase 4: "Low-stock thresholds and stock movement history". One number per product — when a
-- branch's balance of it is at or below that number, the shelf is breached and the Stock screen
-- says so. It lives on the PRODUCT because the catalogue is shared across branches (owner decision
-- §18): a reorder point is a fact about the good, not about one shelf. Per-shelf levels would be a
-- per-branch attribute like pricing (item 4.11) and are deliberately not this.
--
-- NULL means "no alert configured": a product with no threshold is never a breach, so a shop opts
-- each line IN to being watched instead of drowning in every zero-stock service item. Units are
-- the product's BASE units, the same units the Stock screen counts in.
ALTER TABLE products
  ADD COLUMN reorder_point numeric(18, 6)
  CONSTRAINT products_reorder_point_nonneg CHECK (reorder_point IS NULL OR reorder_point >= 0);
