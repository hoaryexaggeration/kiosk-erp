import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

describe('inventory — receiving, adjustment, weighted-average cost (Phase 4)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let dbs: DbService;
  const deviceId = '99999999-9999-4999-8999-999999999998';
  let ownerToken: string;
  let cashierToken: string;

  const auth = (token: string, req: request.Test) => req.set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    const base = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    const adminToken = base.body.accessToken;
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ deviceId, branchId: SEED.branchId, name: 'Stock till' });

    ownerToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
    cashierToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const receiptCommand = (receiptId: string, commandId: string, quantity: number, unitCostMinor: number) => ({
    commandId,
    branchId: SEED.branchId,
    deviceId,
    aggregateType: 'StockReceipt',
    aggregateId: receiptId,
    schemaVersion: 1,
    payload: { receipt: { id: receiptId, reason: 'grn', lines: [{ productId: SEED.productA, quantity, unitCostMinor }] } },
  });

  it('receives stock, rolls the weighted-average cost, and is idempotent', async () => {
    const receiptId = 'aaaa1111-1111-4111-8111-111111111111';
    const command = receiptCommand(receiptId, 'bbbb1111-1111-4111-8111-111111111111', 10, 5000);

    const first = await auth(ownerToken, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(first.body.results[0].status).toBe('accepted');

    const balance = await dbs.db.selectFrom('stock_balances').selectAll().where('product_id', '=', SEED.productA).executeTakeFirstOrThrow();
    expect(Number(balance.quantity)).toBe(10);

    const product = await dbs.db.selectFrom('products').selectAll().where('id', '=', SEED.productA).executeTakeFirstOrThrow();
    expect(Number(product.cost_minor)).toBe(5000); // (0*4500 + 10*5000) / 10

    const dup = await auth(ownerToken, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(dup.body.results[0].status).toBe('duplicate');

    const movements = await dbs.db.selectFrom('inventory_movements').selectAll().where('source_id', '=', receiptId).execute();
    expect(movements).toHaveLength(1);
  });

  it('adjusts stock with a mandatory reason', async () => {
    const adjustmentId = 'cccc1111-1111-4111-8111-111111111111';
    const command = {
      commandId: 'dddd1111-1111-4111-8111-111111111111',
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'StockAdjustment',
      aggregateId: adjustmentId,
      schemaVersion: 1,
      payload: { adjustment: { id: adjustmentId, reason: 'shrinkage', lines: [{ productId: SEED.productA, quantityDelta: -3 }] } },
    };
    const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(res.body.results[0].status).toBe('accepted');

    const balance = await dbs.db.selectFrom('stock_balances').selectAll().where('product_id', '=', SEED.productA).executeTakeFirstOrThrow();
    expect(Number(balance.quantity)).toBe(7);
  });

  it('raises a visible exception when an adjustment drives stock negative', async () => {
    const adjustmentId = 'eeee1111-1111-4111-8111-111111111111';
    const command = {
      commandId: 'ffff1111-1111-4111-8111-111111111111',
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'StockAdjustment',
      aggregateId: adjustmentId,
      schemaVersion: 1,
      payload: { adjustment: { id: adjustmentId, reason: 'stocktake', lines: [{ productId: SEED.productA, quantityDelta: -100 }] } },
    };
    const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(res.body.results[0].status).toBe('review_required');

    const conflicts = await dbs.db.selectFrom('conflict_cases').selectAll().where('aggregate_id', '=', adjustmentId).execute();
    expect(conflicts.map((c) => c.code)).toContain('NEGATIVE_STOCK');
  });

  it('exposes balances and movements read models', async () => {
    const balances = await auth(ownerToken, request(app.getHttpServer()).get('/v1/inventory/balances'));
    expect(balances.status).toBe(200);
    expect(balances.body.balances.length).toBeGreaterThan(0);

    const movements = await auth(ownerToken, request(app.getHttpServer()).get(`/v1/inventory/movements?productId=${SEED.productA}`));
    expect(movements.body.movements.length).toBeGreaterThanOrEqual(3);
  });

  it('enforces permissions on synced commands (cashier cannot receive stock)', async () => {
    const command = receiptCommand('aaaa2222-2222-4222-8222-222222222222', 'bbbb2222-2222-4222-8222-222222222222', 1, 1000);
    const res = await auth(cashierToken, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('FORBIDDEN');
  });
});
