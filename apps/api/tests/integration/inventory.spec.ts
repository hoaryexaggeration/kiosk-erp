import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

describe('inventory — receipts, adjustments and FIFO valuation (Phase 4, ADR 0009)', () => {
  let dbs: DbService;
  let app: INestApplication;
  const deviceId = '99999999-9999-4999-8999-999999999998';
  let ownerToken: string;
  let cashierToken: string;

  const auth = (token: string, req: request.Test) => req.set('authorization', `Bearer ${token}`);
  const push = (token: string, command: unknown) => auth(token, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });

  const balanceOf = async (productId: string) => {
    const row = await dbs.db.selectFrom('stock_balances').selectAll().where('product_id', '=', productId).executeTakeFirst();
    return Number(row?.quantity ?? 0);
  };

  // Heads are exactly 24 characters, so appending a 12-digit serial yields a valid UUID. An
  // off-by-one here produces a 35/37-character string that the envelope validator rejects.
  let seq = 0;
  const nextUuid = (head: string) => `${head}${String((seq += 1)).padStart(12, '0')}`;

  const receipt = (productId: string, quantity: number, unitCostMinor: number) => {
    const id = nextUuid('aaaa1111-1111-4111-8111-');
    return {
      commandId: nextUuid('bbbb1111-1111-4111-8111-'),
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'StockReceipt',
      aggregateId: id,
      schemaVersion: 1,
      payload: { receipt: { id, reason: 'grn', lines: [{ productId, quantity, unitCostMinor }] } },
    };
  };

  const adjustment = (productId: string, quantityDelta: number, extra: Record<string, unknown> = {}) => {
    const id = nextUuid('cccc1111-1111-4111-8111-');
    return {
      commandId: nextUuid('dddd1111-1111-4111-8111-'),
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'StockAdjustment',
      aggregateId: id,
      schemaVersion: 1,
      payload: { adjustment: { id, reason: 'stocktake', lines: [{ productId, quantityDelta }], ...extra } },
    };
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    const base = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${base.body.accessToken}`)
      .send({ deviceId, branchId: SEED.branchId, name: 'Stock till' });

    ownerToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
    cashierToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('seeds opening stock as movements plus valuation layers, never as a bare quantity', async () => {
    // 24 @ 4500 was seeded for product A as a movement + layer (deferred item D3).
    expect(await balanceOf(SEED.productA)).toBe(24);
    const layer = await dbs.db
      .selectFrom('inventory_valuation_layers')
      .selectAll()
      .where('product_id', '=', SEED.productA)
      .where('unit_cost_minor', '=', 4500)
      .executeTakeFirstOrThrow();
    expect(Number(layer.quantity_remaining)).toBe(24);
    const openingMovement = await dbs.db.selectFrom('inventory_movements').selectAll().where('reason', '=', 'opening').where('product_id', '=', SEED.productA).execute();
    expect(openingMovement).toHaveLength(1);
  });

  it('opens a FIFO layer at the received cost and is idempotent', async () => {
    const command = receipt(SEED.productA, 10, 5000);
    const first = await push(ownerToken, command);
    expect(first.body.results[0].status).toBe('accepted');

    expect(await balanceOf(SEED.productA)).toBe(34); // 24 opening + 10 received

    const layer = await dbs.db
      .selectFrom('inventory_valuation_layers')
      .selectAll()
      .where('product_id', '=', SEED.productA)
      .where('unit_cost_minor', '=', 5000)
      .execute();
    expect(layer).toHaveLength(1);
    expect(Number(layer[0].quantity_remaining)).toBe(10);

    // `products.cost_minor` is retained as the latest known purchase cost (display only).
    const product = await dbs.db.selectFrom('products').selectAll().where('id', '=', SEED.productA).executeTakeFirstOrThrow();
    expect(Number(product.cost_minor)).toBe(5000);

    const dup = await push(ownerToken, command);
    expect(dup.body.results[0].status).toBe('duplicate');

    const movements = await dbs.db.selectFrom('inventory_movements').selectAll().where('source_id', '=', command.aggregateId).execute();
    expect(movements).toHaveLength(1);
  });

  it('consumes the oldest layers first and records exactly what the issue cost', async () => {
    // A second, dearer receipt, then an issue that has to span layers.
    expect((await push(ownerToken, receipt(SEED.productA, 10, 6000))).body.results[0].status).toBe('accepted');
    expect(await balanceOf(SEED.productA)).toBe(44); // 24@4500 + 10@5000 + 10@6000

    const issue = adjustment(SEED.productA, -25);
    const res = await push(ownerToken, issue);
    expect(res.body.results[0].status).toBe('accepted');
    expect(await balanceOf(SEED.productA)).toBe(19);

    // 24 @ 4500 = 108000, then 1 @ 5000 = 5000 => 113000. Never the newest layer first.
    const movement = await dbs.db
      .selectFrom('inventory_movements')
      .selectAll()
      .where('source_id', '=', issue.aggregateId)
      .executeTakeFirstOrThrow();
    expect(Number(movement.cogs_minor)).toBe(113000);

    const allocations = await dbs.db
      .selectFrom('inventory_cost_allocations')
      .selectAll()
      .where('movement_id', '=', movement.id)
      .orderBy('quantity', 'desc')
      .execute();
    expect(allocations).toHaveLength(2);
    expect(Number(allocations[0].quantity)).toBe(24);
    expect(Number(allocations[0].unit_cost_minor)).toBe(4500);
    expect(Number(allocations[1].quantity)).toBe(1);
    expect(Number(allocations[1].unit_cost_minor)).toBe(5000);

    // Remaining layers: 9 @ 5000 + 10 @ 6000 = 105000 for 19 units.
    const valuation = await auth(ownerToken, request(app.getHttpServer()).get(`/v1/inventory/valuation?branchId=${SEED.branchId}`));
    const line = valuation.body.lines.find((l: { productId: string }) => l.productId === SEED.productA);
    expect(line.quantityRemaining).toBe(19);
    expect(line.valueMinor).toBe(105000);
  });

  it('refuses to take stock negative without a supervisor override, and raises a conflict', async () => {
    const issue = adjustment(SEED.productB, -1000);
    const res = await push(ownerToken, issue);
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('OVERRIDE_REQUIRED');
    expect(await balanceOf(SEED.productB)).toBe(24); // untouched: nothing partially applied

    const conflicts = await dbs.db.selectFrom('conflict_cases').selectAll().where('aggregate_id', '=', issue.aggregateId).execute();
    expect(conflicts.map((c) => c.code)).toContain('NEGATIVE_STOCK');
  });

  it('allows a negative result with a supervisor override, flagged for review', async () => {
    const issue = adjustment(SEED.productB, -100, { approvedBy: SEED.ownerId, approvalNote: 'Stock count discrepancy approved' });
    const res = await push(ownerToken, issue);
    expect(res.body.results[0].status).toBe('review_required');
    expect(await balanceOf(SEED.productB)).toBe(-76);

    const movement = await dbs.db.selectFrom('inventory_movements').selectAll().where('source_id', '=', issue.aggregateId).executeTakeFirstOrThrow();
    expect(movement.approved_by).toBe(SEED.ownerId);
    // Cost basis runs out after the 24 seeded units, so part of the issue is uncosted.
    expect(Number(movement.cogs_minor)).toBe(96000); // 24 @ 4000
  });

  it('exposes balances, movements and valuation read models', async () => {
    const balances = await auth(ownerToken, request(app.getHttpServer()).get('/v1/inventory/balances'));
    expect(balances.status).toBe(200);
    expect(balances.body.balances.length).toBeGreaterThan(0);

    const movements = await auth(ownerToken, request(app.getHttpServer()).get(`/v1/inventory/movements?productId=${SEED.productA}`));
    // opening + 2 receipts + 1 issue
    expect(movements.body.movements.length).toBeGreaterThanOrEqual(4);
    // The till's history screen reads these exact keys, so pin them here rather than in the UI.
    const newest = movements.body.movements[0];
    expect(newest).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        product_id: SEED.productA,
        sku: expect.any(String),
        source_type: expect.any(String),
        occurred_at: expect.anything(),
      }),
    );
    expect(typeof Number(newest.quantity_delta)).toBe('number');

    const valuation = await auth(ownerToken, request(app.getHttpServer()).get('/v1/inventory/valuation'));
    expect(valuation.status).toBe(200);
    expect(valuation.body.totalValueMinor).toBeGreaterThan(0);
  });

  it('enforces permissions on synced commands (cashier cannot receive stock)', async () => {
    const res = await push(cashierToken, receipt(SEED.productA, 1, 1000));
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('FORBIDDEN');
  });
});
