import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

describe('sync push/pull — offline cash sale (Phase 3/5)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let dbs: DbService;
  let deviceId: string;
  let token: string;

  const auth = (req: request.Test) => req.set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    const enrollBase = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    expect(enrollBase.status).toBe(201);
    const ownerToken = enrollBase.body.accessToken;

    deviceId = '99999999-9999-4999-8999-999999999999';
    const enroll = await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, branchId: SEED.branchId, name: 'Test till', isOfflineAuthoritative: true });
    expect(enroll.status).toBe(201);

    const login = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const cashSaleCommand = (saleId: string, lineId: string, tenderId: string, commandId: string) => ({
    commandId,
    branchId: SEED.branchId,
    deviceId,
    aggregateType: 'Sale',
    aggregateId: saleId,
    aggregateVersion: 1,
    localSequence: 1,
    clientCreatedAt: new Date().toISOString(),
    schemaVersion: 1,
    idempotencyKey: `sale:${saleId}`,
    dependsOn: [],
    payload: {
      sale: {
        id: saleId,
        localNumber: 'LL-MAIN-0001',
        currency: 'KES',
        priceSnapshotVersion: 1,
        lines: [
          { id: lineId, productId: SEED.productA, sku: 'SKU-001', name: 'Bread 400g', unit: 'ea', quantity: 2, unitPriceMinor: 6500, discountBp: 0, taxRateBp: 1600, taxInclusive: true },
        ],
        tenders: [{ id: tenderId, method: 'cash', amountMinor: 13000 }],
      },
    },
  });

  it('accepts a cash sale and posts canonical effects atomically', async () => {
    const saleId = 'aaaaaaaa-0001-4000-8000-000000000001';
    const command = cashSaleCommand(saleId, 'bbbbbbbb-0001-4000-8000-000000000001', 'cccccccc-0001-4000-8000-000000000001', 'dddddddd-0001-4000-8000-000000000001');
    const res = await auth(request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe('accepted');
    expect(res.body.results[0].result.totalMinor).toBe(13000);
    expect(res.body.results[0].result.taxTotalMinor).toBe(1793);

    const sale = await dbs.db.selectFrom('sales').selectAll().where('id', '=', saleId).executeTakeFirstOrThrow();
    expect(sale.state).toBe('accepted');
    expect(sale.total_minor).toBe(13000);

    const lines = await dbs.db.selectFrom('sale_lines').selectAll().where('sale_id', '=', saleId).execute();
    expect(lines).toHaveLength(1);
    expect(lines[0].net_minor).toBe(11207);

    const tenders = await dbs.db.selectFrom('tenders').selectAll().where('sale_id', '=', saleId).execute();
    expect(tenders).toHaveLength(1);
    expect(tenders[0].status).toBe('recorded');
    expect(tenders[0].verified).toBe(true);

    const movements = await dbs.db.selectFrom('inventory_movements').selectAll().where('source_id', '=', saleId).execute();
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].quantity_delta)).toBe(-2);

    const balance = await dbs.db.selectFrom('stock_balances').selectAll().where('product_id', '=', SEED.productA).executeTakeFirstOrThrow();
    // 24 units of opening stock (seed) less the 2 sold here (ADR 0009 valuation layers).
    expect(Number(balance.quantity)).toBe(22);

    // Journal must balance.
    const journal = await dbs.db.selectFrom('journals').selectAll().where('source_id', '=', saleId).executeTakeFirstOrThrow();
    const jl = await dbs.db.selectFrom('journal_lines').selectAll().where('journal_id', '=', journal.id).execute();
    const debit = jl.reduce((s, l) => s + Number(l.debit_minor), 0);
    const credit = jl.reduce((s, l) => s + Number(l.credit_minor), 0);
    expect(debit).toBe(credit);
    // Cash 13000 + COGS (2 x 4500, from the oldest FIFO layer) 9000 = 22000 debit; revenue 11207 +
    // tax 1793 + inventory relief 9000 = 22000 credit.
    expect(debit).toBe(22000);

    // COGS must come from the FIFO layers, not from a weighted-average product cost.
    expect(Number(movements[0].cogs_minor)).toBe(9000);
  });

  it('returns the same result for a duplicate command (idempotent)', async () => {
    const saleId = 'aaaaaaaa-0002-4000-8000-000000000002';
    const command = cashSaleCommand(saleId, 'bbbbbbbb-0002-4000-8000-000000000002', 'cccccccc-0002-4000-8000-000000000002', 'dddddddd-0002-4000-8000-000000000002');
    const first = await auth(request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(first.body.results[0].status).toBe('accepted');

    const second = await auth(request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(second.body.results[0].status).toBe('duplicate');

    const sales = await dbs.db.selectFrom('sales').selectAll().where('id', '=', saleId).execute();
    expect(sales).toHaveLength(1);
    const movements = await dbs.db.selectFrom('inventory_movements').selectAll().where('source_id', '=', saleId).execute();
    expect(movements).toHaveLength(1); // no double stock relief
  });

  it('raises a visible exception (not a silent failure) when offline credit is exceeded', async () => {
    const tightCustomerId = 'eeeeeeee-0001-4000-8000-000000000001';
    await dbs.db
      .insertInto('customers')
      .values({ id: tightCustomerId, tenant_id: SEED.tenantId, name: 'Tight Credit', credit_limit_minor: 1000 })
      .execute();

    const saleId = 'aaaaaaaa-0003-4000-8000-000000000003';
    const command = {
      commandId: 'dddddddd-0003-4000-8000-000000000003',
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'Sale',
      aggregateId: saleId,
      schemaVersion: 1,
      payload: {
        sale: {
          id: saleId,
          customerId: tightCustomerId,
          currency: 'KES',
          lines: [{ id: 'bbbbbbbb-0003-4000-8000-000000000003', productId: SEED.productB, sku: 'SKU-002', name: 'Milk 500ml', unit: 'ea', quantity: 1, unitPriceMinor: 5800, taxRateBp: 1600, taxInclusive: true }],
          tenders: [{ id: 'cccccccc-0003-4000-8000-000000000003', method: 'credit', amountMinor: 5800 }],
        },
      },
    };
    const res = await auth(request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(res.body.results[0].status).toBe('review_required');

    // The sale is preserved (never deleted) and a conflict case exists.
    const sale = await dbs.db.selectFrom('sales').selectAll().where('id', '=', saleId).executeTakeFirstOrThrow();
    expect(sale.state).toBe('review_required');
    const conflicts = await dbs.db.selectFrom('conflict_cases').selectAll().where('aggregate_id', '=', saleId).execute();
    expect(conflicts.map((c) => c.code)).toContain('CREDIT_EXCEEDED');
  });

  it('pulls ordered server deltas for the tenant', async () => {
    const res = await auth(request(app.getHttpServer()).get('/v1/sync/pull?cursor=0&limit=100'));
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    const types = res.body.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toContain('sale.created');
    expect(res.body.cursor).toBeGreaterThan(0);
  });

  it('rejects commands whose device does not match the session', async () => {
    const command = cashSaleCommand('aaaaaaaa-0004-4000-8000-000000000004', 'bbbbbbbb-0004-4000-8000-000000000004', 'cccccccc-0004-4000-8000-000000000004', 'dddddddd-0004-4000-8000-000000000004');
    command.deviceId = '99999999-9999-4999-8999-000000000000';
    const res = await auth(request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('DEVICE_MISMATCH');
  });

  it('requires authentication for sync', async () => {
    const res = await request(app.getHttpServer()).post('/v1/sync/push').send({ commands: [] });
    expect(res.status).toBe(401);
  });
});
