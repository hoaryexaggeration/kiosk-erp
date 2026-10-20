import request from 'supertest';
import { sql } from 'kysely';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

/**
 * Stocktakes / cycle counts (item 4.8, §3.D "cycle counts and full stocktakes").
 *
 * The property under test is the one the phase is judged by: **a count produces adjustment
 * movements with reason and actor** — there is no path that edits an on-hand quantity directly
 * (§15: "stock quantities cannot be changed without a movement source").
 *
 * Two properties separate a count from a clever edit, and every test below leans on one of them:
 *   1. the device sends COUNTED quantities, never deltas — the variance is derived per line
 *      against the server's own book, so a drifted device cache cannot decide where the shelf
 *      lands;
 *   2. counted >= 0 — a count cannot push stock below zero, so unlike an adjustment it needs no
 *      supervisor override; the refusals here are about a count that was never a number at all.
 *
 * The tests share one seeded shop and run in file order, so later counts build on earlier ones —
 * each asserts against the book it reads at the time.
 */
describe('stocktakes — a count becomes movements (item 4.8)', () => {
  let app: INestApplication;
  let dbs: DbService;

  const stocktakeDeviceId = '99999999-9999-4999-8999-999999999998';
  const SKU008 = '88888888-8888-4888-8888-888888888808'; // Soda 300ml: opening 48, crate = 24
  const SKU009 = '88888888-8888-4888-8888-888888888809'; // Drinking water: opening 36, crate = 12
  const SKU010 = '88888888-8888-4888-8888-888888888810'; // Orange juice: opening 0, never received
  const SKU011 = '88888888-8888-4888-8888-888888888811'; // Tomatoes: kg, opening 15

  let ownerToken: string;
  let cashierToken: string;

  const auth = (token: string, req: request.Test) => req.set('authorization', `Bearer ${token}`);
  const push = (token: string, command: unknown) =>
    auth(token, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });

  let seq = 0;
  const id = (head: string) => `${head}${String((seq += 1)).padStart(12, '0')}`;
  const STOCKTAKE_HEAD = 'cccc2222-1111-4111-8111-';
  const COMMAND_HEAD = 'dddd2222-1111-4111-8111-';

  /** A count command: the quantities are what the operator READ off the shelf, never a delta. */
  const stocktakeCommand = (opts: {
    stocktakeId: string;
    lines: Array<{ productId: string; quantity: number; unit?: string }>;
    note?: string;
  }) => ({
    commandId: id(COMMAND_HEAD),
    branchId: SEED.branchId,
    deviceId: stocktakeDeviceId,
    aggregateType: 'Stocktake',
    aggregateId: opts.stocktakeId,
    schemaVersion: 1,
    payload: {
      stocktake: { id: opts.stocktakeId, lines: opts.lines, ...(opts.note ? { note: opts.note } : {}) },
    },
  });

  const balanceAt = async (productId: string) => {
    const row = await dbs.db
      .selectFrom('stock_balances')
      .select('quantity')
      .where('product_id', '=', productId)
      .where('branch_id', '=', SEED.branchId)
      .executeTakeFirst();
    return Number(row?.quantity ?? 0);
  };

  const movementsFor = (sourceId: string) =>
    dbs.db.selectFrom('inventory_movements').selectAll().where('source_id', '=', sourceId).execute();

  const movementCountFor = async (productId: string) => {
    const rows = await dbs.db
      .selectFrom('inventory_movements')
      .select('id')
      .where('product_id', '=', productId)
      .where('branch_id', '=', SEED.branchId)
      .execute();
    return rows.length;
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    const base = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${base.body.accessToken}`)
      .send({ deviceId: stocktakeDeviceId, branchId: SEED.branchId, name: 'Count clipboard' });

    ownerToken = (
      await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId: stocktakeDeviceId })
    ).body.accessToken;
    cashierToken = (
      await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId: stocktakeDeviceId })
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('turns every disagreement into an adjustment movement with reason and actor', async () => {
    const stocktakeId = id(STOCKTAKE_HEAD);
    const res = await push(
      ownerToken,
      stocktakeCommand({
        stocktakeId,
        note: 'Sunday night count',
        lines: [
          { productId: SEED.productA, quantity: 20 },
          { productId: SEED.productB, quantity: 30 },
        ],
      }),
    ).expect(201);

    // Seeded: bread 24, milk 24. Counted 20 and 30 — one short, one found.
    expect(res.body.results[0]).toMatchObject({
      status: 'accepted',
      result: { stocktakeId, countedLines: 2, varianceLines: 2, matchedLines: 0, uncosted: false },
    });
    expect(res.body.results[0].result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: SEED.productA, sku: 'SKU-001', bookBefore: 24, counted: 20, variance: -4 }),
        expect.objectContaining({ productId: SEED.productB, sku: 'SKU-002', bookBefore: 24, counted: 30, variance: 6 }),
      ]),
    );

    const movements = await movementsFor(stocktakeId);
    expect(movements).toHaveLength(2);
    const loss = movements.find((m) => m.product_id === SEED.productA)!;
    expect(loss).toMatchObject({
      branch_id: SEED.branchId,
      quantity_delta: -4,
      unit: 'ea',
      reason: 'stocktake',
      source_type: 'stocktake',
      actor_id: SEED.ownerId,
      device_id: stocktakeDeviceId,
    });
    // The shortage is costed at the FIFO layer it drew on — a shrinkage is a loss in shillings too.
    expect(Number(loss.cogs_minor)).toBe(4 * 4500);
    const found = movements.find((m) => m.product_id === SEED.productB)!;
    expect(found).toMatchObject({ quantity_delta: 6, reason: 'stocktake', source_type: 'stocktake', cogs_minor: null });

    // The shelf lands on the count, not on the book plus somebody's delta.
    expect(await balanceAt(SEED.productA)).toBe(20);
    expect(await balanceAt(SEED.productB)).toBe(30);

    // The count itself is on the audit trail, note included.
    const audit = await dbs.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'stock.counted')
      .where('aggregate_id', '=', stocktakeId)
      .executeTakeFirst();
    expect(audit).toMatchObject({
      aggregate_type: 'Stocktake',
      actor_id: SEED.ownerId,
      reason: 'stocktake',
    });
    expect(audit?.after_summary).toMatchObject({ note: 'Sunday night count', countedLines: 2, matchedLines: 0, varianceLines: 2 });

    // History shows the person, not only the number (§15: "audit every adjustment").
    const history = await auth(ownerToken, request(app.getHttpServer()).get(`/v1/inventory/movements?productId=${SEED.productA}&limit=50`)).expect(200);
    const shown = (history.body.movements as Array<Record<string, unknown>>).find((m) => m.source_id === stocktakeId);
    expect(shown).toMatchObject({ reason: 'stocktake', source_type: 'stocktake', actor_id: SEED.ownerId, actor_name: 'Owner' });
  });

  it('writes nothing at all for a line that agrees with the book', async () => {
    const before = await movementCountFor(SEED.productA);
    const stocktakeId = id(STOCKTAKE_HEAD);
    const res = await push(
      ownerToken,
      stocktakeCommand({ stocktakeId, lines: [{ productId: SEED.productA, quantity: 20 }, { productId: SEED.productB, quantity: 30 }] }),
    ).expect(201);

    expect(res.body.results[0]).toMatchObject({
      status: 'accepted',
      result: { countedLines: 2, matchedLines: 2, varianceLines: 0, lostValueMinor: 0, foundValueMinor: 0 },
    });
    // A shelf that is counted correctly is not a thing that happened: the ledger stays silent.
    expect(await movementCountFor(SEED.productA)).toBe(before);
    expect(await movementsFor(stocktakeId)).toHaveLength(0);
    expect(await balanceAt(SEED.productA)).toBe(20);
  });

  it('counts zero as "none here" — the shelf empties and the loss is booked at FIFO cost', async () => {
    // Milk stood at 30 from the first count: the opening layer of 24 plus 6 found, all at 4000.
    const stocktakeId = id(STOCKTAKE_HEAD);
    const res = await push(ownerToken, stocktakeCommand({ stocktakeId, lines: [{ productId: SEED.productB, quantity: 0 }] })).expect(201);

    expect(res.body.results[0]).toMatchObject({
      status: 'accepted',
      result: { varianceLines: 1, lostValueMinor: 30 * 4000, foundValueMinor: 0, uncosted: false },
    });
    const [movement] = await movementsFor(stocktakeId);
    expect(movement).toMatchObject({ quantity_delta: -30, unit: 'ea', reason: 'stocktake', source_type: 'stocktake' });
    expect(Number(movement.cogs_minor)).toBe(30 * 4000);

    expect(await balanceAt(SEED.productB)).toBe(0);
    const layers = await dbs.db
      .selectFrom('inventory_valuation_layers')
      .select('quantity_remaining')
      .where('product_id', '=', SEED.productB)
      .where('branch_id', '=', SEED.branchId)
      .execute();
    expect(layers.reduce((sum, l) => sum + Number(l.quantity_remaining), 0)).toBe(0);
  });

  it('writes a pack count as the pack when the variance divides exactly, and in base units when it does not', async () => {
    // Water counts in crates of 12: 36 on the shelf, counted as 2 crate — one crate short, exactly,
    // so history can read the pack the sheet was written in.
    const crateStocktake = id(STOCKTAKE_HEAD);
    const crate = await push(
      ownerToken,
      stocktakeCommand({ stocktakeId: crateStocktake, lines: [{ productId: SKU009, quantity: 2, unit: 'crate' }] }),
    ).expect(201);
    expect(crate.body.results[0]).toMatchObject({ status: 'accepted', result: { varianceLines: 1, convertedLines: 1 } });
    const [crateMovement] = await movementsFor(crateStocktake);
    expect(crateMovement).toMatchObject({
      quantity_delta: -12,
      unit: 'ea',
      entered_unit: 'crate',
      entered_quantity: -1,
      reason: 'stocktake',
    });
    expect(await balanceAt(SKU009)).toBe(24);

    // Soda's book is pinned to 50 — not a whole number of 24-bottle crates. Counted 1 crate, the
    // shelf is 26 bottles short, and there IS no whole-pack truth to write: a fraction of a crate
    // is not something a shelf can hold, so the variance goes down in base units.
    await dbs.db
      .updateTable('stock_balances')
      .set({ quantity: 50 })
      .where('tenant_id', '=', SEED.tenantId)
      .where('branch_id', '=', SEED.branchId)
      .where('product_id', '=', SKU008)
      .execute();
    const oddStocktake = id(STOCKTAKE_HEAD);
    await push(ownerToken, stocktakeCommand({ stocktakeId: oddStocktake, lines: [{ productId: SKU008, quantity: 1, unit: 'crate' }] })).expect(201);
    const [oddMovement] = await movementsFor(oddStocktake);
    expect(oddMovement).toMatchObject({ quantity_delta: -26, unit: 'ea', entered_unit: null, entered_quantity: null });
    expect(await balanceAt(SKU008)).toBe(24);
  });

  it('takes a fractional count of a weighed product — tomatoes are read, not counted', async () => {
    const stocktakeId = id(STOCKTAKE_HEAD);
    const res = await push(ownerToken, stocktakeCommand({ stocktakeId, lines: [{ productId: SKU011, quantity: 14.5 }] })).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'accepted', result: { varianceLines: 1, uncosted: false } });
    const [movement] = await movementsFor(stocktakeId);
    expect(movement).toMatchObject({ quantity_delta: -0.5, unit: 'kg', entered_unit: null, reason: 'stocktake' });
    expect(await balanceAt(SKU011)).toBe(14.5);
  });

  it('refuses a fractional count of a counted product whole — the shelf is left untouched', async () => {
    const before = await movementCountFor(SEED.productA);
    const res = await push(
      ownerToken,
      stocktakeCommand({ stocktakeId: id(STOCKTAKE_HEAD), lines: [{ productId: SEED.productA, quantity: 20.5 }] }),
    ).expect(201);

    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'FRACTIONAL_QUANTITY' });
    expect(res.body.results[0].message).toContain('whole number');
    expect(await movementCountFor(SEED.productA)).toBe(before);
    expect(await balanceAt(SEED.productA)).toBe(20);
  });

  it('refuses a negative count — you cannot count −2 bottles', async () => {
    const res = await push(
      ownerToken,
      stocktakeCommand({ stocktakeId: id(STOCKTAKE_HEAD), lines: [{ productId: SEED.productA, quantity: -1 }] }),
    ).expect(201);

    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'VALIDATION_ERROR' });
    expect(res.body.results[0].message).toContain('quantity');
    expect(await balanceAt(SEED.productA)).toBe(20);
  });

  it('drops lines the server has never heard of, and refuses a count of only those', async () => {
    const unknownId = 'eeee2222-1111-4111-8111-000000000001';
    const mixed = await push(
      ownerToken,
      stocktakeCommand({ stocktakeId: id(STOCKTAKE_HEAD), lines: [{ productId: unknownId, quantity: 5 }, { productId: SEED.productA, quantity: 19 }] }),
    ).expect(201);

    expect(mixed.body.results[0]).toMatchObject({ status: 'accepted', result: { countedLines: 1, varianceLines: 1, matchedLines: 0 } });
    expect(await balanceAt(SEED.productA)).toBe(19);

    const nothing = await push(ownerToken, stocktakeCommand({ stocktakeId: id(STOCKTAKE_HEAD), lines: [{ productId: unknownId, quantity: 5 }] })).expect(201);
    expect(nothing.body.results[0]).toMatchObject({ status: 'rejected', code: 'EMPTY_STOCKTAKE' });
  });

  it('replaying a command does not count the same shelf twice', async () => {
    const command = stocktakeCommand({ stocktakeId: id(STOCKTAKE_HEAD), lines: [{ productId: SEED.productA, quantity: 15 }] });
    const first = await push(ownerToken, command).expect(201);
    expect(first.body.results[0].status).toBe('accepted');
    expect(await balanceAt(SEED.productA)).toBe(15);
    const movementCount = (await movementsFor(command.aggregateId)).length;

    const second = await push(ownerToken, command).expect(201);
    expect(second.body.results[0]).toMatchObject({ status: 'duplicate' });
    expect(await balanceAt(SEED.productA)).toBe(15);
    expect((await movementsFor(command.aggregateId)).length).toBe(movementCount);
  });

  it('refuses a count from a role without inventory.adjust, and writes nothing', async () => {
    const before = await movementCountFor(SEED.productA);
    const res = await push(
      cashierToken,
      stocktakeCommand({ stocktakeId: id(STOCKTAKE_HEAD), lines: [{ productId: SEED.productA, quantity: 0 }] }),
    ).expect(201);

    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'FORBIDDEN' });
    expect(res.body.results[0].message).toContain('inventory.adjust');
    expect(await movementCountFor(SEED.productA)).toBe(before);
    expect(await balanceAt(SEED.productA)).toBe(15);
  });

  it('books a count short of a book with no valuation behind it for review, never silently', async () => {
    // Orange juice has never been received (opening 0), so the ledger holds no cost layer for it —
    // yet here is a shelf claiming ten. The count still goes through: a shelf is a shelf. What it
    // cannot cost is a review, not a quiet number (the rule a sale follows too).
    await sql`
      INSERT INTO stock_balances (tenant_id, branch_id, location_id, product_id, quantity, updated_at)
      VALUES (${SEED.tenantId}, ${SEED.branchId}, ${SEED.locationId}, ${SKU010}, 10, now())
      ON CONFLICT (tenant_id, branch_id, location_id, product_id) DO UPDATE SET quantity = 10
    `.execute(dbs.db);

    const stocktakeId = id(STOCKTAKE_HEAD);
    const command = stocktakeCommand({ stocktakeId, lines: [{ productId: SKU010, quantity: 0 }] });
    const res = await push(ownerToken, command).expect(201);

    expect(res.body.results[0]).toMatchObject({
      status: 'review_required',
      result: { stocktakeId, varianceLines: 1, lostValueMinor: 0, uncosted: true },
    });
    // The exception is durable and auditable like every other conflict (§6) — never swallowed.
    const conflicts = await dbs.db.selectFrom('conflict_cases').select('code').where('command_id', '=', command.commandId).execute();
    expect(conflicts.map((c) => c.code)).toEqual(['UNCOSTED_STOCK']);

    // Nothing was costed, and the movement says exactly that: `cogs_minor` stays NULL rather than
    // becoming a confident 0 — "never costed" and "costed at nothing" are different claims.
    const [movement] = await movementsFor(stocktakeId);
    expect(movement).toMatchObject({ quantity_delta: -10, unit: 'ea', reason: 'stocktake', cogs_minor: null });
    expect(await balanceAt(SKU010)).toBe(0);
  });
});
