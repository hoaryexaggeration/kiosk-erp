import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';

/**
 * Price lists, scheduled prices and price-change history (item 4.11, D5).
 *
 * The contract under test: one shelf may legitimately price the same good differently, a dated
 * row takes over the moment its window opens (computed from cached data, offline-capable), every
 * price write is versioned AND historical in the same transaction, and a sale charged at a stale
 * price is FLAGGED — never silently re-priced (§13, architecture line 394).
 */
describe('price lists + price history (Phase 4, item 4.11)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let token: string;
  let cashierToken: string;
  let cashSessionId: string;
  const deviceId = '99999999-9999-4999-8999-999999999994';
  const cashierDeviceId = '99999999-9999-4999-8999-999999999993';

  const auth = (bearer: string, req: request.Test) => req.set('authorization', `Bearer ${bearer}`);
  const resolve = (productId: string, extra = '') => auth(token, request(app.getHttpServer()).get(`/v1/pricing/resolve?productId=${productId}${extra}`));
  // The demo catalogue's id scheme (seed-dev): SKU-004 oil and SKU-006 maize flour.
  const oilId = '88888888-8888-4888-8888-888888888804';
  const flourId = '88888888-8888-4888-8888-888888888806';

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    const adminToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password })).body.accessToken;
    for (const [id, name] of [
      [deviceId, 'Price list test'],
      [cashierDeviceId, 'Price list cashier'],
    ] as const) {
      await request(app.getHttpServer()).post('/v1/devices/enroll').set('authorization', `Bearer ${adminToken}`).send({ deviceId: id, branchId: SEED.branchId, name });
    }
    token = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
    cashierToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId: cashierDeviceId })).body.accessToken;

    // Item 5.2: the stale-price sale below still needs a drawer to belong to.
    cashSessionId = 'eeeeeeee-0001-4000-8000-0000000000ff';
    const open = await auth(token, request(app.getHttpServer()).post('/v1/sync/push')).send({
      commands: [
        {
          commandId: 'dddddddd-0001-4000-8000-0000000000ff',
          branchId: SEED.branchId,
          deviceId,
          aggregateType: 'CashSessionOpen',
          aggregateId: cashSessionId,
          schemaVersion: 1,
          payload: { id: cashSessionId, branchId: SEED.branchId, openingFloatMinor: 5000, openedAt: new Date(Date.now() - 60_000).toISOString() },
        },
      ],
    });
    expect(open.status).toBe(201);
    expect(open.body.results[0].status).toBe('accepted');
  });

  afterAll(async () => {
    await app.close();
  });

  it('prices one shelf differently from the shared catalogue (branch override)', async () => {
    // SKU-004 oil: 320.00 at Main, 330.00 at West — the seed's branch list row.
    const west = await resolve(oilId, `&branchId=${SEED.westBranchId}`);
    expect(west.status).toBe(200);
    expect(west.body).toMatchObject({ unitPriceMinor: 33000, basePriceMinor: 33000, source: 'override' });
    expect(west.body.priceOverrideId).toBeTruthy();

    const main = await resolve(oilId, `&branchId=${SEED.branchId}`);
    expect(main.status).toBe(200);
    expect(main.body).toMatchObject({ unitPriceMinor: 32000, source: 'list' });
    expect(main.body.priceOverrideId).toBeNull();
  });

  it('takes a scheduled price over exactly when its window opens, and not a second before', async () => {
    // SKU-006 maize flour: 235.00 today; a tenant-wide 220.00 is scheduled from 2030-01-01.
    const before = await resolve(flourId, '&asOf=2029-12-31T23:59:59Z');
    expect(before.body).toMatchObject({ unitPriceMinor: 23500, source: 'list' });

    const after = await resolve(flourId, '&asOf=2030-01-01T00:00:00Z');
    expect(after.body).toMatchObject({ unitPriceMinor: 22000, source: 'override' });
  });

  it('lets a branch row beat a tenant-wide row on its own shelf', async () => {
    const sku004 = await auth(token, request(app.getHttpServer()).get('/v1/products?limit=500'));
    const oil = sku004.body.products.find((p: { sku: string }) => p.sku === 'SKU-004');
    const tenantWide = await auth(token, request(app.getHttpServer()).post('/v1/pricing/overrides')).send({
      productId: oil.id,
      priceMinor: 31000,
      validFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(tenantWide.status).toBe(201);

    // Main follows the tenant-wide row; West keeps its own — most specific scope wins.
    const main = await resolve(oil.id, `&branchId=${SEED.branchId}`);
    expect(main.body).toMatchObject({ unitPriceMinor: 31000, source: 'override' });
    const west = await resolve(oil.id, `&branchId=${SEED.westBranchId}`);
    expect(west.body.unitPriceMinor).toBe(33000);

    const removed = await auth(token, request(app.getHttpServer()).delete(`/v1/pricing/overrides/${tenantWide.body.id}`));
    expect(removed.status).toBe(200);
    const backToBase = await resolve(oil.id, `&branchId=${SEED.branchId}`);
    expect(backToBase.body.unitPriceMinor).toBe(32000);
  });

  it('versions a base price change — and only the price — with history in the same stroke', async () => {
    const created = await auth(token, request(app.getHttpServer()).post('/v1/products')).send({
      sku: 'PH4-PRICE-1',
      name: 'Price version test',
      priceMinor: 1000,
    });
    expect(created.status).toBe(201);
    expect(created.body.price_version).toBe(1);

    const opening = await auth(token, request(app.getHttpServer()).get(`/v1/pricing/history?productId=${created.body.id}`));
    expect(opening.body.history[0]).toMatchObject({ oldPriceMinor: null, newPriceMinor: 1000, source: 'edit', actorName: 'Owner' });

    const repriced = await auth(token, request(app.getHttpServer()).patch(`/v1/products/${created.body.id}`)).send({
      priceMinor: 1200,
      expectedVersion: created.body.version,
    });
    expect(repriced.status).toBe(200);
    expect(repriced.body.price_version).toBe(2);

    // A description typo must NOT move the price version: a device's snapshot of the price is
    // only stale when the price actually moved.
    const retitled = await auth(token, request(app.getHttpServer()).patch(`/v1/products/${created.body.id}`)).send({
      description: 'irrelevant to price',
      expectedVersion: repriced.body.version,
    });
    expect(retitled.status).toBe(200);
    expect(retitled.body.price_version).toBe(2);

    const history = await auth(token, request(app.getHttpServer()).get(`/v1/pricing/history?productId=${created.body.id}`));
    expect(history.body.history[0]).toMatchObject({ oldPriceMinor: 1000, newPriceMinor: 1200, source: 'edit' });
  });

  it('versions and records prices changed by a bulk import', async () => {
    const product = await auth(token, request(app.getHttpServer()).get('/v1/products?limit=500'));
    const target = product.body.products.find((p: { sku: string }) => p.sku === 'PH4-PRICE-1');
    const imported = await auth(token, request(app.getHttpServer()).post('/v1/products/import')).send({
      csv: ['sku,name,price', 'PH4-PRICE-1,Price version test,15'].join('\n'),
      commit: true,
    });
    expect(imported.body).toMatchObject({ status: 'committed', errorCount: 0 });

    const after = await auth(token, request(app.getHttpServer()).get('/v1/products?limit=500'));
    const updated = after.body.products.find((p: { sku: string }) => p.sku === 'PH4-PRICE-1');
    expect(updated.price_minor).toBe(1500);
    expect(updated.price_version).toBe(target.price_version + 1);

    const history = await auth(token, request(app.getHttpServer()).get(`/v1/pricing/history?productId=${target.id}`));
    expect(history.body.history[0]).toMatchObject({ oldPriceMinor: 1200, newPriceMinor: 1500, source: 'import' });
  });

  it('writes history on every override lifecycle step, removal included', async () => {
    const target = (await auth(token, request(app.getHttpServer()).get('/v1/products?limit=500'))).body.products.find(
      (p: { sku: string }) => p.sku === 'PH4-PRICE-1',
    );
    const created = await auth(token, request(app.getHttpServer()).post('/v1/pricing/overrides')).send({
      productId: target.id,
      branchId: SEED.branchId,
      priceMinor: 2000,
      validFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(created.status).toBe(201);

    const changed = await auth(token, request(app.getHttpServer()).patch(`/v1/pricing/overrides/${created.body.id}`)).send({ priceMinor: 2500 });
    expect(changed.status).toBe(200);

    // The override is in force for Main right now.
    const onShelf = await resolve(target.id, `&branchId=${SEED.branchId}`);
    expect(onShelf.body).toMatchObject({ unitPriceMinor: 2500, source: 'override' });

    const removed = await auth(token, request(app.getHttpServer()).delete(`/v1/pricing/overrides/${created.body.id}`));
    expect(removed.status).toBe(200);
    const backToBase = await resolve(target.id, `&branchId=${SEED.branchId}`);
    expect(backToBase.body.unitPriceMinor).toBe(1500); // the base price, not the ghost of the list

    const history = await auth(token, request(app.getHttpServer()).get(`/v1/pricing/history?productId=${target.id}`));
    const sources = history.body.history.map((h: { source: string }) => h.source);
    expect(sources.slice(0, 3)).toEqual(['override_removed', 'override', 'override']);
    expect(history.body.history[0]).toMatchObject({ oldPriceMinor: 2500, newPriceMinor: 1500, source: 'override_removed' });
  });

  it('flags a sale charged at a stale price instead of silently re-pricing it', async () => {
    const saleId = 'aaaaaaaa-0001-4000-8000-000000000011';
    const command = {
      commandId: 'dddddddd-0001-4000-8000-000000000011',
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
          localNumber: 'LL-MAIN-9001',
          cashSessionId,
          currency: 'KES',
          priceSnapshotVersion: 1,
          lines: [
            // The device was offline while SKU-001 moved to 65.00 and charges the old 60.00.
            { id: 'bbbbbbbb-0001-4000-8000-000000000011', productId: SEED.productA, sku: 'SKU-001', name: 'Bread 400g', unit: 'ea', quantity: 2, unitPriceMinor: 6000, discountBp: 0, taxRateBp: 1600, taxInclusive: true },
          ],
          tenders: [{ id: 'cccccccc-0001-4000-8000-000000000011', method: 'cash', amountMinor: 12000 }],
        },
      },
    };
    const res = await auth(token, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe('accepted');
    const warnings: string[] = res.body.results[0].result.warnings ?? [];
    expect(warnings.join(' | ')).toMatch(/STALE_PRICE_SNAPSHOT SKU-001: charged 6000, policy 6500/);
    // The completed receipt is NOT re-priced: the trace is the warning, the money is as charged.
    expect(res.body.results[0].result.totalMinor).toBe(12000);
  });

  it('refuses nonsense overrides and non-managers', async () => {
    const target = (await auth(token, request(app.getHttpServer()).get('/v1/products?limit=500'))).body.products.find(
      (p: { sku: string }) => p.sku === 'PH4-PRICE-1',
    );

    const negative = await auth(token, request(app.getHttpServer()).post('/v1/pricing/overrides')).send({
      productId: target.id,
      priceMinor: -1,
      validFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(negative.status).toBe(422);

    const backwards = await auth(token, request(app.getHttpServer()).post('/v1/pricing/overrides')).send({
      productId: target.id,
      priceMinor: 100,
      validFrom: '2021-01-01T00:00:00.000Z',
      validTo: '2020-01-01T00:00:00.000Z',
    });
    expect(backwards.status).toBe(422);

    const unknownBranch = await auth(token, request(app.getHttpServer()).post('/v1/pricing/overrides')).send({
      productId: target.id,
      branchId: '99999999-9999-4999-8999-999999999999',
      priceMinor: 100,
      validFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(unknownBranch.status).toBe(422);

    // A cashier may READ prices but not move them (§5 roles).
    const cashierWrite = await auth(cashierToken, request(app.getHttpServer()).post('/v1/pricing/overrides')).send({
      productId: target.id,
      priceMinor: 100,
      validFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(cashierWrite.status).toBe(403);
    const cashierHistory = await auth(cashierToken, request(app.getHttpServer()).get(`/v1/pricing/history?productId=${target.id}`));
    expect(cashierHistory.status).toBe(403);
  });
});
