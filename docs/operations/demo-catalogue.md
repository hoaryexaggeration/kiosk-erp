# Demo catalogue (development seed)

The dev seed (`npm --workspace apps/api run seed:dev`) loads a shop-shaped catalogue so that a phone
test has something real to look at: several categories, weighed and counted units, barcodes to scan,
stock with valuation layers, and a few deliberately awkward rows that exist to prove a rule.

**It is demo data, not tax advice.** Rates and the chart of accounts still need accountant sign-off
(Phase 8) — see `docs/product/decision-register.md`.

## Access

| | |
|---|---|
| Owner | `owner@kiosk.test` / `demo1234` |
| Cashier | `cashier@kiosk.test` / `demo1234` |
| Branch | `22222222-2222-4222-8222-222222222222` (MAIN · Main Kiosk) |
| Store location | `99999999-9999-4999-8999-999999999991` (Store) |

**Getting it onto a device.** Settings → fill in the address, email, password, branch and device id
→ *Set up*. Enrolment finishes with a first sync, which pulls this catalogue down; after that the
till sells from its own copy and works with no connection. The same pull is what Sync Centre runs on
demand, and Setup → Catalogue has a manual refresh.

## Categories

Groceries · Beverages · Fresh produce · Household · Personal care

## Tax categories

| Name | Rate | Note |
|---|---|---|
| VAT 16% (inclusive) | 1600 bp | the default for everything below |
| Zero-rated (0%) | 0 bp | applied to loose fresh produce, so a 0% line can be rung through the till next to 16% |

## Products

Prices and costs are shown in KES; the system stores integer minor units.

| SKU | Name | Category | Unit | Price | Cost | Barcode(s) | Opening |
|---|---|---|---|---:|---:|---|---:|
| SKU-001 | Bread 400g | — | ea | 65.00 | 45.00 | `6001000000011` | 24 |
| SKU-002 | Milk 500ml | — | ea | 58.00 | 40.00 | `6001000000028` | 24 |
| SKU-003 | Sugar 1kg | Groceries | ea | 185.00 | 145.00 | `6001000000032` | 40 |
| SKU-004 | Sunflower oil 1L | Groceries | ea | 320.00 | 265.00 | `6001000000049` | 24 |
| SKU-005 | Pishori rice 2kg | Groceries | ea | 420.00 | 340.00 | `6001000000056` | 18 |
| SKU-006 | Maize flour 2kg | Groceries | ea | 235.00 | 190.00 | `6001000000063` | 30 |
| SKU-007 | Tea leaves 250g | Groceries | ea | 275.00 | 220.00 | `6001000000070` | 20 |
| SKU-008 | Soda 300ml | Beverages | ea | 80.00 | 55.00 | `6001000000087` · `6001000000216` | 48 |
| SKU-009 | Drinking water 1L | Beverages | ea | 70.00 | 45.00 | `6001000000094` | 36 |
| SKU-010 | Orange juice 300ml | Beverages | ea | 120.00 | 85.00 | `6001000000100` | — |
| SKU-011 | Tomatoes | Fresh produce | kg | 120.00 | 80.00 | none | 15 |
| SKU-012 | Bananas | Fresh produce | kg | 150.00 | 100.00 | none | 12 |
| SKU-013 | Eggs tray (30) | Fresh produce | ea | 480.00 | 410.00 | `6001000000131` | 10 |
| SKU-014 | Detergent 500g | Household | ea | 210.00 | 170.00 | `6001000000148` | 25 |
| SKU-015 | Bar soap 800g | Household | ea | 95.00 | 70.00 | `6001000000155` | 40 |
| SKU-016 | Toilet paper (4 rolls) | Household | ea | 260.00 | 210.00 | `6001000000162` | 22 |
| SKU-017 | Toothpaste 100ml | Personal care | ea | 175.00 | 135.00 | `6001000000179` | 20 |
| SKU-018 | Shampoo 400ml | Personal care | ea | 380.00 | 310.00 | `6001000000186` | 8 |
| SKU-019 | Mobile top-up KES 100 | — | ea | 100.00 | 100.00 | none | — |
| SKU-020 | Dishwashing liquid 750ml | Household | ea | 240.00 | 195.00 | `6001000000209` | 14 |

20 products · 18 barcodes · 18 opening movements (one per product that was received).

## What each awkward row is for

| Row | Proves |
|---|---|
| SKU-008 has **two** barcodes | barcodes are a SET: both tags resolve to the same product, and removing one in the editor removes it everywhere after sync |
| SKU-011 / SKU-012 have **no** barcode | search and tap-to-add still work; scanning is not the only way in |
| SKU-010 was **never received** | "no stock recorded" shows as `—`, never as `0` |
| SKU-019 is **not stock-tracked** | no stock row exists at all, and it has no category, so the empty category is visible too |
| SKU-020 is **deactivated** | it sits in Stock with its 14 units but must never appear in the till's list or accept a scan |
| SKU-011 / SKU-012 are **zero-rated** | a 0% line rings through beside 16% VAT lines, and the totals still agree with `Pricing` |
| Everything with opening stock | arrived as a `opening_stock` movement plus a FIFO valuation layer (ADR 0009), never as a bare quantity edit |

## Barcode check digits

Every tag added after the original two is a valid EAN-13 (the check digit is computed by `ean13` in
`src/db/seed-dev.ts`), so a printed label scans with any reader. The two original tags —
`6001000000011` and `6001000000028` — predate that and are pinned by the test suite; ML Kit reads
them regardless, but they are not valid EAN-13s.

## Resetting

The seed is idempotent: running it twice changes nothing. For a truly clean database:

```bash
docker exec kiosk-erp-postgres psql -U kiosk -d kiosk_erp -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
npm --workspace apps/api run migration:run
npm --workspace apps/api run seed:dev
```
