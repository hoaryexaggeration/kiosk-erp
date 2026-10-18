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
  ownerId: '33333333-3333-4333-8333-333333333333',
  cashierId: '33333333-3333-4333-8333-333333333334',
  ownerRoleId: '44444444-4444-4444-8444-444444444441',
  cashierRoleId: '44444444-4444-4444-8444-444444444442',
  licenseId: '55555555-5555-4555-8555-555555555555',
  taxCategoryId: '66666666-6666-4666-8666-666666666666',
  customerId: '77777777-7777-4777-8777-777777777777',
  productA: '88888888-8888-4888-8888-888888888881',
  productB: '88888888-8888-4888-8888-888888888882',
  ownerEmail: 'owner@kiosk.test',
  cashierEmail: 'cashier@kiosk.test',
  password: 'demo1234',
} as const;

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
      .values({ id: SEED.branchId, tenant_id: SEED.tenantId, code: 'MAIN', name: 'Main Kiosk' })
      .onConflict((oc) => oc.column('id').doNothing())
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

    // Tax category (16% VAT, inclusive pricing common in Kenyan retail).
    await trx
      .insertInto('tax_categories')
      .values({ id: SEED.taxCategoryId, tenant_id: SEED.tenantId, name: 'VAT 16% (inclusive)', rate_bp: 1600, inclusive: true })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Products.
    await trx
      .insertInto('products')
      .values([
        { id: SEED.productA, tenant_id: SEED.tenantId, sku: 'SKU-001', name: 'Bread 400g', tax_category_id: SEED.taxCategoryId, price_minor: 6500, cost_minor: 4500, unit: 'ea' },
        { id: SEED.productB, tenant_id: SEED.tenantId, sku: 'SKU-002', name: 'Milk 500ml', tax_category_id: SEED.taxCategoryId, price_minor: 5800, cost_minor: 4000, unit: 'ea' },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx.insertInto('barcodes').values({ tenant_id: SEED.tenantId, product_id: SEED.productA, barcode: '6001000000011' }).onConflict((oc) => oc.columns(['tenant_id', 'barcode']).doNothing()).execute();
    await trx.insertInto('barcodes').values({ tenant_id: SEED.tenantId, product_id: SEED.productB, barcode: '6001000000028' }).onConflict((oc) => oc.columns(['tenant_id', 'barcode']).doNothing()).execute();

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
      .values({ tenant_id: SEED.tenantId, branch_id: SEED.branchId, name: 'Store', kind: 'store' })
      .onConflict((oc) => oc.doNothing())
      .execute();

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
      console.log(`  branch:  ${SEED.branchId}`);
      await dbs.onModuleDestroy();
    })
    .catch(async (err) => {
      console.error(err);
      await dbs.onModuleDestroy();
      process.exit(1);
    });
}
