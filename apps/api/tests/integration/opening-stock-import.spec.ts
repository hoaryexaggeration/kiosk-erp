import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

/**
 * Opening-stock import (item 4.5). The exit criterion for this item is the one under test below:
 * an opening balance arrives as a MOVEMENT with a reason and a date, and the stored quantity is
 * only ever derived from those movements — never written by the import itself.
 */
describe('opening-stock import (Phase 4, item 4.5)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let dbs: DbService;
  let token: string;
  let cashierToken: string;
  const deviceId = '99999999-9999-4999-8999-999999999994';

  const auth = (bearer: string, req: request.Test) => req.set('authorization', `Bearer ${bearer}`);
  const runImport = (bearer: string, body: Record<string, unknown>) =>
    auth(bearer, request(app.getHttpServer()).post('/v1/inventory/opening-stock/import')).send(body);
  const push = (bearer: string, command: unknown) => auth(bearer, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });

  let uuidSeq = 0;
  const uuid = () => `aaaa0000-0000-4000-8000-${String((uuidSeq += 1)).padStart(12, '0')}`;

  const productBySku = (sku: string) =>
    dbs.db
      .selectFrom('products')
      .select(['id', 'sku', 'cost_minor', 'is_stock_tracked'])
      .where('tenant_id', '=', SEED.tenantId)
      .where('sku', '=', sku)
      .executeTakeFirstOrThrow();

  const balanceOf = async (productId: string) => {
    const row = await dbs.db.selectFrom('stock_balances').selectAll().where('product_id', '=', productId).executeTakeFirst();
    return Number(row?.quantity ?? 0);
  };

  const openingMovements = (productId: string) =>
    dbs.db
      .selectFrom('inventory_movements')
      .selectAll()
      .where('tenant_id', '=', SEED.tenantId)
      .where('product_id', '=', productId)
      .where('source_type', '=', 'opening_stock')
      .execute();

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    const base = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password })).body.accessToken;
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${base}`)
      .send({ deviceId, branchId: SEED.branchId, name: 'Opening stock till' });
    token = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
    cashierToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('previews a valid file and writes nothing at all', async () => {
    const product = await productBySku('SKU-010');
    const res = await runImport(token, {
      branchId: SEED.branchId,
      requestId: uuid(),
      csv: 'sku,quantity\nSKU-010,60',
      commit: false,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'validated',
      alreadyApplied: false,
      rowCount: 1,
      validCount: 1,
      errorCount: 0,
      warningCount: 0,
      totalQuantity: 60,
      // The cost falls back to what the catalogue already records, so the layer opens costed.
      totalValueMinor: 60 * 8500,
    });
    expect(res.body.preview[0]).toMatchObject({ sku: 'SKU-010', quantity: 60, onHandBefore: 0, onHandAfter: 60, costWasGiven: false });
    expect(await balanceOf(product.id)).toBe(0);
    expect(await openingMovements(product.id)).toHaveLength(0);
  });

  it('commits opening stock as an audited movement that opens a FIFO valuation layer', async () => {
    const product = await productBySku('SKU-010');
    const requestId = uuid();
    const res = await runImport(token, {
      branchId: SEED.branchId,
      requestId,
      csv: 'sku,quantity,unit_cost\nSKU-010,60,95',
      commit: true,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'committed', alreadyApplied: false, validCount: 1, totalValueMinor: 60 * 9500 });
    expect(await balanceOf(product.id)).toBe(60);

    // The fact, not the quantity: reason, source and the idempotency key that produced it.
    const movements = await openingMovements(product.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      branch_id: SEED.branchId,
      location_id: SEED.locationId,
      reason: 'opening',
      source_type: 'opening_stock',
      source_id: requestId,
      command_id: requestId,
      actor_id: SEED.ownerId,
      device_id: deviceId,
      quantity_delta: 60,
    });

    const layer = await dbs.db
      .selectFrom('inventory_valuation_layers')
      .selectAll()
      .where('product_id', '=', product.id)
      .executeTakeFirstOrThrow();
    expect(layer).toMatchObject({ unit_cost_minor: 9500, quantity_received: 60, quantity_remaining: 60 });

    // A cost stated by the file becomes the product's latest known purchase cost; valuation itself
    // stays layer-based (ADR 0009).
    expect(Number(product.cost_minor)).toBe(8500);
    const after = await productBySku('SKU-010');
    expect(Number(after.cost_minor)).toBe(9500);

    const audit = await dbs.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'opening_stock.imported')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ aggregate_type: 'StockOpening', aggregate_id: requestId, actor_id: SEED.ownerId });
  });

  it('recognises a replayed commit instead of applying the opening stock twice', async () => {
    const product = await productBySku('SKU-010');
    const body = { branchId: SEED.branchId, requestId: uuid(), csv: 'sku,quantity\nSKU-010,60', commit: true };
    const movementsBefore = await openingMovements(product.id);
    const balanceBefore = await balanceOf(product.id);

    const first = await runImport(token, body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'committed', alreadyApplied: false });
    const movementsAfterFirst = await openingMovements(product.id);
    expect(movementsAfterFirst).toHaveLength(movementsBefore.length + 1);
    expect(await balanceOf(product.id)).toBe(balanceBefore + 60);

    // The device retries after a timeout: same file, same request id, no second lot of stock.
    const replay = await runImport(token, body);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ status: 'committed', alreadyApplied: true });
    expect(await openingMovements(product.id)).toHaveLength(movementsAfterFirst.length);
    expect(await balanceOf(product.id)).toBe(balanceBefore + 60);
  });

  it('reports every bad row of an unusable file and writes nothing at all', async () => {
    const product = await productBySku('SKU-011');
    const before = await balanceOf(product.id);
    const res = await runImport(token, {
      branchId: SEED.branchId,
      requestId: uuid(),
      csv: 'sku,quantity\nSKU-011,5\nSKU-NOPE,5\nSKU-012,0',
      commit: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('invalid');
    expect(res.body.errors.map((error: { code: string }) => error.code)).toEqual(['UNKNOWN_SKU', 'QUANTITY_NOT_POSITIVE']);
    expect(res.body.errors.map((error: { line: number }) => error.line)).toEqual([3, 4]);
    expect(res.body.validCount).toBe(1);
    expect(await balanceOf(product.id)).toBe(before);
    expect(await productBySku('SKU-012').then((p) => balanceOf(p.id))).toBe(12);
  });

  it('warns — without blocking — that opening stock for the product is already present', async () => {
    const res = await runImport(token, {
      branchId: SEED.branchId,
      requestId: uuid(),
      csv: 'sku,quantity\nSKU-003,10',
      commit: false,
    });

    expect(res.body.status).toBe('validated');
    expect(res.body.warningCount).toBe(1);
    expect(res.body.warnings[0]).toMatchObject({ code: 'OPENING_ALREADY_PRESENT', sku: 'SKU-003', line: 2 });
    expect(res.body.preview[0]).toMatchObject({ onHandBefore: 40, onHandAfter: 50 });
  });

  it('warns at file level when the branch has already traded', async () => {
    const productId = (await productBySku('SKU-012')).id;
    await push(token, {
      commandId: uuid(),
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'StockReceipt',
      aggregateId: uuid(),
      schemaVersion: 1,
      payload: { receipt: { id: uuid(), reason: 'grn', lines: [{ productId, quantity: 5, unitCostMinor: 10000 }] } },
    });

    const res = await runImport(token, {
      branchId: SEED.branchId,
      requestId: uuid(),
      csv: 'sku,quantity\nSKU-010,60',
      commit: false,
    });
    expect(res.body.warnings.map((warning: { code: string }) => warning.code)).toContain('BRANCH_ALREADY_TRADING');
    // The rest of the file is still planned: the warning informs, it does not veto.
    expect(res.body.validCount).toBe(1);
  });

  it('refuses to open stock for a product that is not stock-tracked', async () => {
    const res = await runImport(token, {
      branchId: SEED.branchId,
      requestId: uuid(),
      csv: 'sku,quantity\nSKU-019,10',
      commit: true,
    });
    expect(res.body.status).toBe('invalid');
    expect(res.body.errors[0]).toMatchObject({ code: 'PRODUCT_NOT_STOCK_TRACKED', sku: 'SKU-019' });
  });

  it('plans and commits the same rows from JSON records as from a CSV file', async () => {
    const product = await productBySku('SKU-013');
    const before = await balanceOf(product.id);
    const res = await runImport(token, {
      branchId: SEED.branchId,
      requestId: uuid(),
      records: [{ sku: 'SKU-013', quantity: 5 }],
      commit: true,
    });

    expect(res.body).toMatchObject({ status: 'committed', validCount: 1, rowCount: 1 });
    // SKU-013 already carries opening stock, so the report says so — the same advisory a CSV file
    // would produce, from the same planner.
    expect(res.body.warnings.map((warning: { code: string }) => warning.code)).toContain('OPENING_ALREADY_PRESENT');
    expect(res.body.preview[0]).toMatchObject({ onHandBefore: before, onHandAfter: before + 5 });
    expect(await balanceOf(product.id)).toBe(before + 5);
  });

  it('keeps the stored quantity equal to the sum of its movements — the projection is derived', async () => {
    const product = await productBySku('SKU-010');
    const movements = await openingMovements(product.id);
    const summed = movements.reduce((total, movement) => total + Number(movement.quantity_delta), 0);
    expect(await balanceOf(product.id)).toBe(summed);
  });

  it('requires inventory.receive', async () => {
    const product = await productBySku('SKU-010');
    const movementsBefore = await openingMovements(product.id);
    const balanceBefore = await balanceOf(product.id);

    const res = await runImport(cashierToken, {
      branchId: SEED.branchId,
      requestId: uuid(),
      csv: 'sku,quantity\nSKU-010,60',
      commit: true,
    });
    expect(res.status).toBe(403);
    expect(await openingMovements(product.id)).toHaveLength(movementsBefore.length);
    expect(await balanceOf(product.id)).toBe(balanceBefore);
  });

  it('refuses a branch that is not this tenant’s', async () => {
    const res = await runImport(token, {
      branchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      requestId: uuid(),
      csv: 'sku,quantity\nSKU-010,60',
      commit: false,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_BRANCH');
  });
});
