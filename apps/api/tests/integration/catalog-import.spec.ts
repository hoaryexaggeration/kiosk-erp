import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';

/**
 * Bulk catalogue import (item 4.4). The contract under test is the one the plan states: a malformed
 * file creates NO partial records and reports every bad row, and a preview writes nothing.
 */
describe('catalogue bulk import (Phase 4, item 4.4)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let token: string;
  let cashierToken: string;
  const deviceId = '99999999-9999-4999-8999-999999999996';
  const cashierDeviceId = '99999999-9999-4999-8999-999999999995';

  const auth = (bearer: string, req: request.Test) => req.set('authorization', `Bearer ${bearer}`);
  const runImport = (bearer: string, body: Record<string, unknown>) => auth(bearer, request(app.getHttpServer()).post('/v1/products/import')).send(body);

  const productBySku = async (sku: string) => {
    const res = await auth(token, request(app.getHttpServer()).get('/v1/products?limit=500'));
    return res.body.products.find((product: { sku: string }) => product.sku === sku);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    const adminToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password })).body.accessToken;
    for (const [id, name] of [
      [deviceId, 'Import test'],
      [cashierDeviceId, 'Import cashier'],
    ] as const) {
      await request(app.getHttpServer()).post('/v1/devices/enroll').set('authorization', `Bearer ${adminToken}`).send({ deviceId: id, branchId: SEED.branchId, name });
    }
    token = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
    cashierToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId: cashierDeviceId })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('previews a valid file without writing anything', async () => {
    const res = await runImport(token, { csv: 'sku,name,price\nIMP-1,Preview only,10', commit: false });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'validated', validCount: 1, errorCount: 0, createCount: 1, updateCount: 0 });
    expect(await productBySku('IMP-1')).toBeUndefined();
  });

  it('commits a valid file, resolving tax by name and parsing prices exactly', async () => {
    const res = await runImport(token, {
      csv: [
        'sku,name,price,category,tax,unit,cost,barcodes',
        `IMP-1,Preview only,10.5,Snacks,VAT 16% (inclusive),ea,8,6009000000011|6009000000028`,
      ].join('\n'),
      commit: true,
      createMissingCategories: true,
      createMissingBrands: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'committed', createCount: 1, errorCount: 0, categoriesToCreate: ['Snacks'] });

    const product = await productBySku('IMP-1');
    expect(product).toBeDefined();
    expect(product.price_minor).toBe(1050);
    expect(product.cost_minor).toBe(800);
    expect(product.tax_category_id).toBe(SEED.taxCategoryId);
    expect(product.barcodes.sort()).toEqual(['6009000000011', '6009000000028']);
    expect(product.category_id).toBeTruthy();
  });

  it('resolves a brand by name, and only invents one when the file is allowed to', async () => {
    const withBrand = (brand: string) => ['sku,name,price,brand', `BR-1,Branded biscuits,10,${brand}`].join('\n');

    // An unknown brand is a typo until somebody says otherwise — the same rule categories follow.
    const refused = await runImport(token, { csv: withBrand('Imported Brand'), commit: true });
    expect(refused.status).toBe(201);
    expect(refused.body).toMatchObject({ status: 'invalid', errorCount: 1, brandsToCreate: [] });
    expect(refused.body.errors[0]).toMatchObject({ code: 'UNKNOWN_BRAND', field: 'brand' });
    expect(await productBySku('BR-1')).toBeUndefined();

    // Asked for, the file's own brand becomes a brand and the product points at it.
    const allowed = await runImport(token, { csv: withBrand('Imported Brand'), commit: true, createMissingBrands: true });
    expect(allowed.body).toMatchObject({ status: 'committed', createCount: 1, brandsToCreate: ['Imported Brand'] });
    expect(await productBySku('BR-1')).toMatchObject({ brand_name: 'Imported Brand', brand_id: expect.any(String) });

    // A brand that already exists is matched by name, case-insensitively, and never duplicated.
    const known = await runImport(token, {
      csv: ['sku,name,price,brand', 'BR-2,Existing brand,10,kaskazi drinks'].join('\n'),
      commit: true,
      createMissingBrands: true,
    });
    expect(known.body).toMatchObject({ status: 'committed', brandsToCreate: [] });
    expect(await productBySku('BR-2')).toMatchObject({ brand_name: 'Kaskazi Drinks' });
  });

  it('writes nothing at all when one row is bad, and reports the bad row', async () => {
    const res = await runImport(token, {
      csv: ['sku,name,price', 'IMP-2,Would be fine,20', 'IMP-3,Bad price,not-a-price'].join('\n'),
      commit: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'invalid', validCount: 1, errorCount: 1 });
    expect(res.body.errors[0]).toMatchObject({ line: 3, sku: 'IMP-3', field: 'price', code: 'INVALID_PRICE' });
    // The valid row must NOT exist: a half-imported catalogue is the state we refuse to create.
    expect(await productBySku('IMP-2')).toBeUndefined();
    expect(await productBySku('IMP-3')).toBeUndefined();
  });

  it('updates an existing SKU on a re-import rather than duplicating it', async () => {
    const before = await productBySku('IMP-2');
    expect(before).toBeUndefined();

    const first = await runImport(token, { csv: 'sku,name,price\nIMP-2,First pass,20', commit: true });
    expect(first.body).toMatchObject({ createCount: 1, updateCount: 0 });

    const second = await runImport(token, { csv: 'sku,name,price\nIMP-2,Renamed,25', commit: true });
    expect(second.body).toMatchObject({ createCount: 0, updateCount: 1 });

    const products = await auth(token, request(app.getHttpServer()).get('/v1/products?limit=500'));
    const matches = products.body.products.filter((product: { sku: string }) => product.sku === 'IMP-2');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ name: 'Renamed', price_minor: 2500 });
    expect(matches[0].version).toBe(2);
  });

  it('replaces the barcode set from the file so a removed tag stops resolving', async () => {
    await runImport(token, { csv: 'sku,name,price,barcodes\nIMP-4,Tagged,10,6009000000035', commit: true });
    expect((await auth(token, request(app.getHttpServer()).get('/v1/barcodes/6009000000035'))).status).toBe(200);

    await runImport(token, { csv: 'sku,name,price,barcodes\nIMP-4,Tagged,10,6009000000042', commit: true });
    expect((await auth(token, request(app.getHttpServer()).get('/v1/barcodes/6009000000035'))).status).toBe(404);
    expect((await auth(token, request(app.getHttpServer()).get('/v1/barcodes/6009000000042'))).status).toBe(200);
  });

  it('refuses an unrecognised column instead of importing a price of zero', async () => {
    const res = await runImport(token, { csv: 'sku,name,prise\nIMP-5,Typo,99', commit: true });
    expect(res.body.status).toBe('invalid');
    expect(res.body.errors.map((error: { code: string }) => error.code)).toEqual(expect.arrayContaining(['UNKNOWN_COLUMN', 'MISSING_COLUMN']));
    expect(await productBySku('IMP-5')).toBeUndefined();
  });

  it('accepts JSON records with the same column vocabulary', async () => {
    const res = await runImport(token, {
      records: [{ sku: 'IMP-6', name: 'From JSON', price: '12.34', active: false, barcodes: ['6009000000059'] }],
      commit: true,
    });
    expect(res.body).toMatchObject({ status: 'committed', createCount: 1 });
    const product = await productBySku('IMP-6');
    expect(product).toMatchObject({ price_minor: 1234, is_active: false });
    expect(product.barcodes).toEqual(['6009000000059']);
  });

  it('requires catalog.manage', async () => {
    const res = await runImport(cashierToken, { csv: 'sku,name,price\nIMP-7,Nope,10', commit: true });
    expect(res.status).toBe(403);
    expect(await productBySku('IMP-7')).toBeUndefined();
  });
});
