/**
 * Idempotent development seed. Fixed UUIDs so tests and the Android client can target a known tenant.
 * Run: npm --workspace apps/api run seed:dev
 */
import { sql } from 'kysely';
import { DbService } from './db.service';
import { Database } from './database';
import { hashSecret } from '../common/password';

export const SEED = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  branchId: '22222222-2222-4222-8222-222222222222',
  /** Second demo branch (item 4.7): a transfer needs somewhere to go on a single phone. */
  westBranchId: '22222222-2222-4222-8222-222222222223',
  ownerId: '33333333-3333-4333-8333-333333333333',
  cashierId: '33333333-3333-4333-8333-333333333334',
  ownerRoleId: '44444444-4444-4444-8444-444444444441',
  cashierRoleId: '44444444-4444-4444-8444-444444444442',
  licenseId: '55555555-5555-4555-8555-555555555555',
  taxCategoryId: '66666666-6666-4666-8666-666666666666',
  zeroRatedTaxCategoryId: '66666666-6666-4666-8666-666666666667',
  customerId: '77777777-7777-4777-8777-777777777777',
  locationId: '99999999-9999-4999-8999-999999999991',
  productA: '88888888-8888-4888-8888-888888888881',
  productB: '88888888-8888-4888-8888-888888888882',
  ownerEmail: 'owner@kiosk.test',
  cashierEmail: 'cashier@kiosk.test',
  password: 'demo1234',
} as const;

/**
 * Deterministic id for a demo product: `88888888-8888-4888-8888-8888888888NN`, the same shape the
 * two pinned products above already use, so a test can address one without a lookup.
 */
const demoProductId = (n: number): string => `88888888-8888-4888-8888-8888888888${String(n).padStart(2, '0')}`;

/** Where the demo catalogue files its products. The editor's category picker reads this table. */
export const DEMO_CATEGORIES = [
  { id: 'cccccccc-0000-4000-8000-000000000001', name: 'Groceries' },
  { id: 'cccccccc-0000-4000-8000-000000000002', name: 'Beverages' },
  { id: 'cccccccc-0000-4000-8000-000000000003', name: 'Fresh produce' },
  { id: 'cccccccc-0000-4000-8000-000000000004', name: 'Household' },
  { id: 'cccccccc-0000-4000-8000-000000000005', name: 'Personal care' },
] as const;

/**
 * The demo tenant's unit catalogue (item 4.6). A conversion may only name a unit that appears
 * here, and `kind` decides what the ledger accepts: a `count` base stays whole, `weight` and
 * `volume` may be fractional. Every real tenant needs this set once — `seedDev` is the only place
 * a tenant is created today, so it is also where the catalogue is guaranteed to exist.
 */
export const DEMO_UNITS = [
  { code: 'ea', name: 'Each', kind: 'count' },
  { code: 'bottle', name: 'Bottle', kind: 'count' },
  { code: 'crate', name: 'Crate', kind: 'count' },
  { code: 'pack', name: 'Pack', kind: 'count' },
  { code: 'tray', name: 'Tray', kind: 'count' },
  { code: 'kg', name: 'Kilogram', kind: 'weight' },
  { code: 'g', name: 'Gram', kind: 'weight' },
  { code: 'l', name: 'Litre', kind: 'volume' },
  { code: 'ml', name: 'Millilitre', kind: 'volume' },
] as const;

/** Brands the demo products belong to (§3.C product master). Loose produce is deliberately unbranded. */
export const DEMO_BRANDS = [
  { id: 'bbbbbbbb-0000-4000-8000-000000000001', name: 'Savannah Foods' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Kaskazi Drinks' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000003', name: 'Neema Home' },
] as const;

/** One pack size a product really is bought in: `1 <unit> = <factor> base units` (item 4.6). */
export interface DemoConversion {
  unit: string;
  factor: number;
}

export interface DemoProduct {
  /** Deterministic id suffix. */
  n: number;
  sku: string;
  name: string;
  description?: string;
  category: string | null;
  /** The BASE unit: the only unit stock of this product is ever held in (item 4.6). */
  unit: string;
  brand?: string;
  /** Pack sizes this product is bought in, expressed against `unit`. */
  conversions?: DemoConversion[];
  priceMinor: number;
  costMinor: number;
  taxCategory?: 'zero';
  stockTracked?: boolean;
  active?: boolean;
  /** Twelve-digit EAN-13 bodies; the check digit is added by `ean13`. Empty means "not labelled". */
  barcodes: string[];
  opening?: number;
  /** Low-stock threshold in base units (item 4.9); absent means "no alert configured". */
  reorderPoint?: number;
}

/**
 * The demo catalogue. `SKU-001`/`SKU-002` predate this table and are pinned by the test suite;
 * everything below exists so a phone test has a shop to look at rather than two lonely rows:
 *
 *  - several categories and both weighed (`kg`) and counted (`ea`) units;
 *  - an item carrying two barcodes (tags are a SET) and items carrying none;
 *  - an item with no stock at all, so "unknown" and "zero" stay visibly different;
 *  - an item that is not stock-tracked, and a zero-rated line next to 16% VAT;
 *  - a deactivated item, which must never reach the till no matter how it is searched for.
 *
 * Prices and costs are integer minor units. Opening quantities become movements plus FIFO layers,
 * never a bare balance (ADR 0009) — see the `opening` loop below.
 */
export const DEMO_CATALOGUE: readonly DemoProduct[] = [
  { n: 3, sku: 'SKU-003', name: 'Sugar 1kg', category: 'Groceries', unit: 'ea', brand: 'Savannah Foods', priceMinor: 18500, costMinor: 14500, barcodes: ['600100000003'], opening: 40, description: 'Refined cane sugar' },
  { n: 4, sku: 'SKU-004', name: 'Sunflower oil 1L', category: 'Groceries', unit: 'ea', brand: 'Savannah Foods', priceMinor: 32000, costMinor: 26500, barcodes: ['600100000004'], opening: 24, reorderPoint: 12 },
  { n: 5, sku: 'SKU-005', name: 'Pishori rice 2kg', category: 'Groceries', unit: 'ea', brand: 'Savannah Foods', priceMinor: 42000, costMinor: 34000, barcodes: ['600100000005'], opening: 18, reorderPoint: 20, description: 'Watched: 18 on the shelf breaches the point at 20 (item 4.9)' },
  { n: 6, sku: 'SKU-006', name: 'Maize flour 2kg', category: 'Groceries', unit: 'ea', brand: 'Savannah Foods', priceMinor: 23500, costMinor: 19000, barcodes: ['600100000006'], opening: 30, description: 'Fine grade, unga wa sema' },
  { n: 7, sku: 'SKU-007', name: 'Tea leaves 250g', category: 'Groceries', unit: 'ea', brand: 'Savannah Foods', priceMinor: 27500, costMinor: 22000, barcodes: ['600100000007'], opening: 20 },
  // The crate demonstration (item 4.6): bought by the crate, sold by the bottle, ONE ledger.
  { n: 8, sku: 'SKU-008', name: 'Soda 300ml', category: 'Beverages', unit: 'ea', brand: 'Kaskazi Drinks', conversions: [{ unit: 'crate', factor: 24 }], priceMinor: 8000, costMinor: 5500, barcodes: ['600100000008', '600100000021'], opening: 48, description: 'Returnable bottle — two tags in circulation, 24 to a crate' },
  // A crate is NOT a global constant: water ships 12 to a crate where soda ships 24, which is why
  // a conversion hangs off the product instead of off the unit.
  { n: 9, sku: 'SKU-009', name: 'Drinking water 1L', category: 'Beverages', unit: 'ea', brand: 'Kaskazi Drinks', conversions: [{ unit: 'crate', factor: 12 }], priceMinor: 7000, costMinor: 4500, barcodes: ['600100000009'], opening: 36 },
  { n: 10, sku: 'SKU-010', name: 'Orange juice 300ml', category: 'Beverages', unit: 'ea', brand: 'Kaskazi Drinks', priceMinor: 12000, costMinor: 8500, barcodes: ['600100000010'], opening: 0, description: 'Never received: the till must show "—", not zero' },
  // Weighed goods: a fractional conversion into a `weight` base is a fact, into a `count` base it is not.
  { n: 11, sku: 'SKU-011', name: 'Tomatoes', category: 'Fresh produce', unit: 'kg', conversions: [{ unit: 'g', factor: 0.001 }], priceMinor: 12000, costMinor: 8000, taxCategory: 'zero', barcodes: [], opening: 15, description: 'Loose, weighed at the till' },
  { n: 12, sku: 'SKU-012', name: 'Bananas', category: 'Fresh produce', unit: 'kg', priceMinor: 15000, costMinor: 10000, taxCategory: 'zero', barcodes: [], opening: 12, description: 'Loose, weighed at the till' },
  { n: 13, sku: 'SKU-013', name: 'Eggs tray (30)', category: 'Fresh produce', unit: 'ea', conversions: [{ unit: 'tray', factor: 30 }], priceMinor: 48000, costMinor: 41000, barcodes: ['600100000013'], opening: 10, reorderPoint: 12 },
  { n: 14, sku: 'SKU-014', name: 'Detergent 500g', category: 'Household', unit: 'ea', brand: 'Neema Home', priceMinor: 21000, costMinor: 17000, barcodes: ['600100000014'], opening: 25 },
  { n: 15, sku: 'SKU-015', name: 'Bar soap 800g', category: 'Household', unit: 'ea', brand: 'Neema Home', priceMinor: 9500, costMinor: 7000, barcodes: ['600100000015'], opening: 40, reorderPoint: 15 },
  { n: 16, sku: 'SKU-016', name: 'Toilet paper (4 rolls)', category: 'Household', unit: 'ea', brand: 'Neema Home', priceMinor: 26000, costMinor: 21000, barcodes: ['600100000016'], opening: 22 },
  { n: 17, sku: 'SKU-017', name: 'Toothpaste 100ml', category: 'Personal care', unit: 'ea', brand: 'Neema Home', priceMinor: 17500, costMinor: 13500, barcodes: ['600100000017'], opening: 20 },
  { n: 18, sku: 'SKU-018', name: 'Shampoo 400ml', category: 'Personal care', unit: 'ea', brand: 'Neema Home', priceMinor: 38000, costMinor: 31000, barcodes: ['600100000018'], opening: 8, reorderPoint: 10 },
  { n: 19, sku: 'SKU-019', name: 'Mobile top-up KES 100', category: null, unit: 'ea', priceMinor: 10000, costMinor: 10000, barcodes: [], stockTracked: false, description: 'Sold as a service: no stock, no category' },
  { n: 20, sku: 'SKU-020', name: 'Dishwashing liquid 750ml', category: 'Household', unit: 'ea', brand: 'Neema Home', priceMinor: 24000, costMinor: 19500, barcodes: ['600100000020'], opening: 14, active: false, description: 'Discontinued — must never appear at the till' },
];

/**
 * EAN-13 check digit. The two original seeded tags (`6001000000011`, `6001000000028`) predate this
 * and are pinned by the test suite; every tag added since is a real, printable EAN-13 so a label
 * printer and any hardware scanner agree with what the app expects.
 */
const ean13 = (body12: string): string => {
  const sum = body12.split('').reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return body12 + String((10 - (sum % 10)) % 10);
};

export async function seedDev(dbs: DbService): Promise<void> {
  const db = dbs.db;
  await dbs.transaction(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({ id: SEED.tenantId, name: 'Demo Kiosk', currency: 'KES', timezone: 'Africa/Nairobi' })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('branches')
      .values([
        { id: SEED.branchId, tenant_id: SEED.tenantId, code: 'MAIN', name: 'Main Kiosk' },
        // Item 4.7's second shelf: the demo has to let one phone send goods across a branch line,
        // and there is deliberately no branch-creation endpoint yet (that is catalogue/branch
        // management, not stock). Seeded empty — it receives, it does not start with stock.
        { id: SEED.westBranchId, tenant_id: SEED.tenantId, code: 'WEST', name: 'West Kiosk' },
      ])
      .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
      .execute();

    await trx
      .insertInto('users')
      .values([
        { id: SEED.ownerId, tenant_id: SEED.tenantId, email: SEED.ownerEmail, display_name: 'Owner', password_hash: hashSecret(SEED.password) },
        { id: SEED.cashierId, tenant_id: SEED.tenantId, email: SEED.cashierEmail, display_name: 'Cashier', password_hash: hashSecret(SEED.password) },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('roles')
      .values([
        { id: SEED.ownerRoleId, tenant_id: SEED.tenantId, code: 'owner', name: 'Owner' },
        { id: SEED.cashierRoleId, tenant_id: SEED.tenantId, code: 'cashier', name: 'Cashier' },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    const allPermissions = await trx.selectFrom('permissions').select('code').execute();
    for (const p of allPermissions) {
      await trx.insertInto('role_permissions').values({ role_id: SEED.ownerRoleId, permission_code: p.code }).onConflict((oc) => oc.columns(['role_id', 'permission_code']).doNothing()).execute();
    }
    for (const code of ['pos.sale.create', 'cash.shift.open', 'cash.shift.close', 'reports.view']) {
      await trx.insertInto('role_permissions').values({ role_id: SEED.cashierRoleId, permission_code: code }).onConflict((oc) => oc.columns(['role_id', 'permission_code']).doNothing()).execute();
    }

    await trx.insertInto('user_roles').values({ user_id: SEED.ownerId, role_id: SEED.ownerRoleId }).onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing()).execute();
    await trx.insertInto('user_roles').values({ user_id: SEED.cashierId, role_id: SEED.cashierRoleId }).onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing()).execute();

    // Tax categories (16% VAT inclusive is the Kenyan retail default; the zero rate exists so a
    // 0%-rated line can be exercised at the till next to it). Demo data, not tax advice — the real
    // rates still need accountant sign-off before Phase 8.
    await trx
      .insertInto('tax_categories')
      .values([
        { id: SEED.taxCategoryId, tenant_id: SEED.tenantId, name: 'VAT 16% (inclusive)', rate_bp: 1600, inclusive: true },
        { id: SEED.zeroRatedTaxCategoryId, tenant_id: SEED.tenantId, name: 'Zero-rated (0%)', rate_bp: 0, inclusive: true },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    for (const c of DEMO_CATEGORIES) {
      await trx
        .insertInto('categories')
        .values({ id: c.id, tenant_id: SEED.tenantId, name: c.name, parent_id: null })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
    const categoryIdFor = (name: string | null): string | null => {
      if (name === null) return null;
      return DEMO_CATEGORIES.find((c) => c.name === name)?.id ?? null;
    };

    // Unit catalogue (item 4.6). Idempotent without a conflict target: the uniqueness is on
    // (tenant, lower(code)), an expression index Kysely cannot name, and "insert if absent" is
    // exactly what a repeated seed should do either way.
    for (const u of DEMO_UNITS) {
      await trx
        .insertInto('units_of_measure')
        .values({ tenant_id: SEED.tenantId, code: u.code, name: u.name, kind: u.kind })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    for (const b of DEMO_BRANDS) {
      await trx
        .insertInto('brands')
        .values({ id: b.id, tenant_id: SEED.tenantId, name: b.name })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
    const brandIdFor = (name: string | undefined): string | null =>
      name ? DEMO_BRANDS.find((b) => b.name === name)?.id ?? null : null;

    // Products: the two pinned rows, then the demo catalogue.
    await trx
      .insertInto('products')
      .values([
        { id: SEED.productA, tenant_id: SEED.tenantId, sku: 'SKU-001', name: 'Bread 400g', tax_category_id: SEED.taxCategoryId, brand_id: null, price_minor: 6500, cost_minor: 4500, unit: 'ea' },
        { id: SEED.productB, tenant_id: SEED.tenantId, sku: 'SKU-002', name: 'Milk 500ml', tax_category_id: SEED.taxCategoryId, brand_id: null, price_minor: 5800, cost_minor: 4000, unit: 'ea' },
        ...DEMO_CATALOGUE.map((p) => ({
          id: demoProductId(p.n),
          tenant_id: SEED.tenantId,
          sku: p.sku,
          name: p.name,
          description: p.description ?? null,
          category_id: categoryIdFor(p.category),
          tax_category_id: p.taxCategory === 'zero' ? SEED.zeroRatedTaxCategoryId : SEED.taxCategoryId,
          brand_id: brandIdFor(p.brand),
          unit: p.unit,
          is_stock_tracked: p.stockTracked ?? true,
          is_active: p.active ?? true,
          price_minor: p.priceMinor,
          cost_minor: p.costMinor,
          reorder_point: p.reorderPoint ?? null,
        })),
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx.insertInto('barcodes').values({ tenant_id: SEED.tenantId, product_id: SEED.productA, barcode: '6001000000011' }).onConflict((oc) => oc.columns(['tenant_id', 'barcode']).doNothing()).execute();
    await trx.insertInto('barcodes').values({ tenant_id: SEED.tenantId, product_id: SEED.productB, barcode: '6001000000028' }).onConflict((oc) => oc.columns(['tenant_id', 'barcode']).doNothing()).execute();
    for (const p of DEMO_CATALOGUE) {
      for (const body of p.barcodes) {
        await trx
          .insertInto('barcodes')
          .values({ tenant_id: SEED.tenantId, product_id: demoProductId(p.n), barcode: ean13(body) })
          .onConflict((oc) => oc.columns(['tenant_id', 'barcode']).doNothing())
          .execute();
      }
    }

    // Pack sizes (item 4.6): `1 crate = 24 bottles` is a fact about THIS product — a crate of water
    // is 12 — so it hangs off the product. Nothing already recorded moves: a conversion only
    // decides how a quantity written in a pack becomes the base unit stock is held in.
    for (const p of DEMO_CATALOGUE) {
      for (const c of p.conversions ?? []) {
        await trx
          .insertInto('unit_conversions')
          .values({ tenant_id: SEED.tenantId, product_id: demoProductId(p.n), unit: c.unit, factor: c.factor })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }

    // Price lists (item 4.11): West prices its own shelf — oil at 330 there while Main keeps 320 —
    // and one tenant-wide price is scheduled to take over on a date far enough out (2030) that the
    // demo never flips on its own. Both also demonstrate that history is written with the change.
    const demoOverrides = [
      { id: 'cccc9999-9999-4999-8999-999999999991', productId: demoProductId(4), branchId: SEED.westBranchId, priceMinor: 33000, validFrom: new Date('2020-01-01T00:00:00.000Z') },
      { id: 'cccc9999-9999-4999-8999-999999999992', productId: demoProductId(6), branchId: null, priceMinor: 22000, validFrom: new Date('2030-01-01T00:00:00.000Z') },
    ];
    for (const o of demoOverrides) {
      await trx
        .insertInto('product_price_overrides')
        .values({
          id: o.id,
          tenant_id: SEED.tenantId,
          product_id: o.productId,
          branch_id: o.branchId,
          price_minor: o.priceMinor,
          valid_from: o.validFrom,
          valid_to: null,
          created_by: SEED.ownerId,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('price_change_history')
        .values({
          id: `${o.id.slice(0, -1)}8`,
          tenant_id: SEED.tenantId,
          product_id: o.productId,
          branch_id: o.branchId,
          old_price_minor: null,
          new_price_minor: o.priceMinor,
          source: 'override',
          actor_id: SEED.ownerId,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }

    // Chart of accounts (demo only; the real chart requires accountant sign-off).
    const coa = [
      ['1000', 'Cash', 'asset', false],
      ['1100', 'Accounts Receivable', 'asset', true],
      ['1300', 'Inventory', 'asset', true],
      ['2100', 'Tax Payable', 'liability', false],
      ['4000', 'Sales Revenue', 'revenue', false],
      ['5000', 'Cost of Goods Sold', 'expense', false],
    ] as const;
    for (const [code, name, type, isControl] of coa) {
      await trx
        .insertInto('chart_of_accounts')
        .values({ tenant_id: SEED.tenantId, code, name, type, is_control: isControl })
        .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
        .execute();
    }

    await trx
      .insertInto('customers')
      .values({ id: SEED.customerId, tenant_id: SEED.tenantId, name: 'Walk-in Account', credit_limit_minor: 100000 })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('stock_locations')
      .values({ id: SEED.locationId, tenant_id: SEED.tenantId, branch_id: SEED.branchId, name: 'Store', kind: 'store' })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Opening stock (ADR 0009, deferred item D3): seeded as movements plus FIFO valuation layers,
    // never as a bare quantity in `stock_balances`, so the balance, the ledger and the valuation
    // agree from the first sale. Opening cost is the product's cost_minor. Products with nothing to
    // open (the untracked top-up, the juice that was never received) get no row at all, so "no
    // stock recorded" never masquerades as zero.
    const opening: Array<{
      productId: string;
      unit: string;
      quantity: number;
      unitCostMinor: number;
      movementId: string;
      layerId: string;
    }> = [
      { productId: SEED.productA, unit: 'ea', quantity: 24, unitCostMinor: 4500, movementId: 'aaaa9999-9999-4999-8999-999999999991', layerId: 'bbbb9999-9999-4999-8999-999999999991' },
      { productId: SEED.productB, unit: 'ea', quantity: 24, unitCostMinor: 4000, movementId: 'aaaa9999-9999-4999-8999-999999999992', layerId: 'bbbb9999-9999-4999-8999-999999999992' },
    ];
    for (const p of DEMO_CATALOGUE) {
      const quantity = p.opening ?? 0;
      if (quantity <= 0) continue;
      opening.push({
        productId: demoProductId(p.n),
        unit: p.unit,
        quantity,
        unitCostMinor: p.costMinor,
        movementId: `aaaa9999-9999-4999-8999-${String(p.n).padStart(12, '0')}`,
        layerId: `bbbb9999-9999-4999-8999-${String(p.n).padStart(12, '0')}`,
      });
    }
    for (const o of opening) {
      await trx
        .insertInto('inventory_movements')
        .values({
          id: o.movementId,
          tenant_id: SEED.tenantId,
          branch_id: SEED.branchId,
          location_id: SEED.locationId,
          product_id: o.productId,
          quantity_delta: o.quantity,
          unit: o.unit,
          reason: 'opening',
          source_type: 'opening_stock',
          source_id: null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('inventory_valuation_layers')
        .values({
          id: o.layerId,
          tenant_id: SEED.tenantId,
          branch_id: SEED.branchId,
          location_id: SEED.locationId,
          product_id: o.productId,
          source_movement_id: o.movementId,
          unit_cost_minor: o.unitCostMinor,
          quantity_received: o.quantity,
          quantity_remaining: o.quantity,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await sql`
        INSERT INTO stock_balances (tenant_id, branch_id, location_id, product_id, quantity, updated_at)
        VALUES (${SEED.tenantId}, ${SEED.branchId}, ${SEED.locationId}, ${o.productId}, ${o.quantity}, now())
        ON CONFLICT (tenant_id, branch_id, location_id, product_id) DO NOTHING
      `.execute(trx);
    }

    await trx
      .insertInto('licenses')
      .values({ id: SEED.licenseId, tenant_id: SEED.tenantId, plan_id: 'perpetual_core_single', state: 'perpetual_core_active', device_key_fingerprints: [] })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    const plan = await trx.selectFrom('license_plans').select('entitlement_ids').where('id', '=', 'perpetual_core_single').executeTakeFirst();
    for (const entitlement of plan?.entitlement_ids ?? []) {
      await trx.insertInto('license_entitlements').values({ license_id: SEED.licenseId, entitlement_id: entitlement }).onConflict((oc) => oc.columns(['license_id', 'entitlement_id']).doNothing()).execute();
    }

    await trx
      .insertInto('numbering_series')
      .values({ tenant_id: SEED.tenantId, branch_id: SEED.branchId, name: 'sales', prefix: 'LL', next_value: 1 })
      .onConflict((oc) => oc.doNothing())
      .execute();

    await trx.insertInto('config_versions').values({ tenant_id: SEED.tenantId, version: 1, payload: { currency: 'KES', taxInclusive: true } as never }).onConflict((oc) => oc.columns(['tenant_id', 'version']).doNothing()).execute();
  });
  // Touch a statement so the seed fails loudly if the schema is missing.
  await sql`select 1`.execute(db);
}

if (require.main === module) {
  const dbs = new DbService();
  seedDev(dbs)
    .then(async () => {
      console.log('Dev seed complete.');
      console.log(`  owner:   ${SEED.ownerEmail} / ${SEED.password}`);
      console.log(`  cashier: ${SEED.cashierEmail} / ${SEED.password}`);
      console.log(`  tenant:  ${SEED.tenantId}`);
      console.log(`  branch:  ${SEED.branchId} (Main) + ${SEED.westBranchId} (West — item 4.7's second shelf)`);
      console.log(`  catalogue: ${DEMO_CATALOGUE.length + 2} products in ${DEMO_CATEGORIES.length} categories (see docs/operations/demo-catalogue.md)`);
      console.log(
        `  units:    ${DEMO_UNITS.length} units, ${DEMO_BRANDS.length} brands, ` +
          `${DEMO_CATALOGUE.reduce((n, p) => n + (p.conversions?.length ?? 0), 0)} pack conversions`,
      );
      await dbs.onModuleDestroy();
    })
    .catch(async (err) => {
      console.error(err);
      await dbs.onModuleDestroy();
      process.exit(1);
    });
}
