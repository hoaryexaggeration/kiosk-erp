import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';
import { hashSecret } from '../../src/common/password';

/**
 * Item 5.2 (D10): a sale cannot be recorded without an open cashier session, and the drawer
 * itself opens and closes at the till — offline — as sync commands the server referees.
 */
describe('cashier sessions — the drawer gate on the till (item 5.2)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let dbs: DbService;
  let deviceId: string;
  let token: string;

  const auth = (req: request.Test) => req.set('authorization', `Bearer ${token}`);
  const push = (commands: unknown[]) => auth(request(app.getHttpServer()).post('/v1/sync/push')).send({ commands });

  // One clock for the whole suite: open at T-600s, the good sale at T-300s, close at T-100s,
  // the late sale at T. Deterministic, with no race between "now" calls.
  const T = Date.now();
  const at = (offsetMs: number) => new Date(T + offsetMs).toISOString();

  const sessionId = 'abababab-0001-4000-8000-000000000001';
  const openCommand = (commandId: string, id = sessionId) => ({
    commandId,
    branchId: SEED.branchId,
    deviceId,
    aggregateType: 'CashSessionOpen',
    aggregateId: id,
    schemaVersion: 1,
    payload: { id, branchId: SEED.branchId, openingFloatMinor: 20000, openedAt: at(-600_000) },
  });

  let saleSeq = 0;
  const saleCommand = (cashSessionId: string | undefined, takenAt: string, amountMinor = 13000) => {
    const n = ++saleSeq;
    const saleId = `abababab-000${n}-4000-8000-0000000000${10 + n}`;
    return {
      commandId: `abacacad-000${n}-4000-8000-0000000000${10 + n}`,
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'Sale',
      aggregateId: saleId,
      schemaVersion: 1,
      payload: {
        sale: {
          id: saleId,
          ...(cashSessionId ? { cashSessionId } : {}),
          currency: 'KES',
          clientCreatedAt: takenAt,
          lines: [
            { id: `abaeaf0a-000${n}-4000-8000-0000000000${10 + n}`, productId: SEED.productA, sku: 'SKU-001', name: 'Bread 400g', unit: 'ea', quantity: 2, unitPriceMinor: 6500, discountBp: 0, taxRateBp: 1600, taxInclusive: true },
          ],
          tenders: [{ id: `abafab0a-000${n}-4000-8000-0000000000${10 + n}`, method: 'cash', amountMinor }],
        },
      },
    };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    const adminToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password })).body.accessToken;
    deviceId = '99999999-9999-4999-8999-999999999992';
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ deviceId, branchId: SEED.branchId, name: 'Drawer test till', isOfflineAuthoritative: true });
    token = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('opens a drawer at the till and shows it as the branch’s current session', async () => {
    const res = await push([openCommand('abadabae-0001-4000-8000-000000000001')]);
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe('accepted');
    expect(res.body.results[0].result).toMatchObject({ sessionId, state: 'open' });

    const current = await auth(request(app.getHttpServer()).get(`/v1/cash/sessions/current?branchId=${SEED.branchId}`));
    expect(current.status).toBe(200);
    expect(current.body.session).toMatchObject({ id: sessionId, state: 'open', openingFloatMinor: 20000, openedBy: SEED.ownerId });
    expect(current.body.session.openedAt).toBe(at(-600_000));

    // Another branch has no drawer: the read is scoped, not global.
    const west = await auth(request(app.getHttpServer()).get(`/v1/cash/sessions/current?branchId=${SEED.westBranchId}`));
    expect(west.body.session).toBeNull();
  });

  it('posts a sale taken inside the drawer’s window', async () => {
    const res = await push([saleCommand(sessionId, at(-300_000))]);
    expect(res.body.results[0].status).toBe('accepted');

    const sale = await dbs.db.selectFrom('sales').selectAll().where('cash_session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(sale.state).toBe('accepted');
  });

  it('refuses a sale that names no drawer at all (schema)', async () => {
    const res = await push([saleCommand(undefined, at(-300_000))]);
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('VALIDATION_ERROR');
    expect(res.body.results[0].message).toMatch(/cashSessionId/);
  });

  it('refuses a sale whose drawer never reached the server', async () => {
    const phantom = 'abababab-0002-4000-8000-000000000002';
    const command = saleCommand(phantom, at(-300_000));
    const res = await push([command]);
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('SESSION_REQUIRED');

    // The refusal is durable and silent-free: no sale, no movement, nothing half-applied.
    const sale = await dbs.db.selectFrom('sales').selectAll().where('id', '=', command.aggregateId).executeTakeFirst();
    expect(sale).toBeUndefined();
  });

  it('refuses a sale rung up before the drawer was opened', async () => {
    const res = await push([saleCommand(sessionId, at(-900_000))]);
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('SESSION_NOT_OPEN');
    expect(res.body.results[0].result).toMatchObject({ sessionOpenedAt: at(-600_000), sessionClosedAt: null });
  });

  it('refuses a second drawer on the same branch, with a named, auditable conflict', async () => {
    const clash = 'abababab-0003-4000-8000-000000000003';
    const res = await push([openCommand('abadabae-0003-4000-8000-000000000003', clash)]);
    expect(res.body.results[0].status).toBe('conflict');
    expect(res.body.results[0].code).toBe('SESSION_ALREADY_OPEN');
    expect(res.body.results[0].message).toMatch(/already has an open drawer/);

    const conflict = await dbs.db.selectFrom('conflict_cases').selectAll().where('code', '=', 'SESSION_ALREADY_OPEN').executeTakeFirst();
    expect(conflict?.aggregate_id).toBe(clash);

    // And the branch still has exactly the one drawer it started with.
    const open = await dbs.db.selectFrom('cash_sessions').selectAll().where('branch_id', '=', SEED.branchId).where('state', '=', 'open').execute();
    expect(open.map((s) => s.id)).toEqual([sessionId]);
  });

  it('treats a replayed open command as a duplicate and a re-open of the same session as a no-op', async () => {
    const replay = await push([openCommand('abadabae-0001-4000-8000-000000000001')]);
    expect(replay.body.results[0].status).toBe('duplicate');

    // A different command naming the same session: aggregate-level idempotency, not an error.
    const again = await push([openCommand('abadabaf-0001-4000-8000-000000000001')]);
    expect(again.body.results[0].status).toBe('accepted');
    expect(again.body.results[0].result).toMatchObject({ sessionId, note: 'already open' });

    const rows = await dbs.db.selectFrom('cash_sessions').selectAll().where('id', '=', sessionId).execute();
    expect(rows).toHaveLength(1);
  });

  it('closes the drawer with counted cash, deriving expected on the server', async () => {
    // Float 20000 + the 13000 cash sale above = 33000 expected; the till counted 32950.
    const res = await push([
      {
        commandId: 'abadab0e-0001-4000-8000-000000000001',
        branchId: SEED.branchId,
        deviceId,
        aggregateType: 'CashSessionClose',
        aggregateId: sessionId,
        schemaVersion: 1,
        payload: { id: sessionId, countedMinor: 32950, closedAt: at(-100_000) },
      },
    ]);
    expect(res.body.results[0].status).toBe('accepted');
    expect(res.body.results[0].result).toMatchObject({ countedMinor: 32950, expectedMinor: 33000, varianceMinor: -50 });

    const read = await auth(request(app.getHttpServer()).get(`/v1/cash/sessions/${sessionId}`));
    expect(read.status).toBe(200);
    expect(read.body.session).toMatchObject({ state: 'closed', countedMinor: 32950, expectedMinor: 33000, varianceMinor: -50, closedAt: at(-100_000) });

    // The count is a reading; the derivation is the books. Both are audited with the actor.
    const audit = await dbs.db.selectFrom('audit_events').selectAll().where('action', '=', 'cash.session.closed').executeTakeFirst();
    expect(audit?.actor_id).toBe(SEED.ownerId);
    expect(audit?.reason).toContain('expected 33000');
  });

  it('refuses a sale taken after the drawer closed', async () => {
    const res = await push([saleCommand(sessionId, at(0))]);
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('SESSION_NOT_OPEN');
    expect(res.body.results[0].result).toMatchObject({ sessionClosedAt: at(-100_000) });
  });

  it('requires the shift permission to open a drawer (role gate, server-side)', async () => {
    // A tenant user with NO roles at all: permissions resolve to [].
    const noRolesEmail = 'noroles@kiosk.test';
    await dbs.db
      .insertInto('users')
      .values({ id: 'abababab-0004-4000-8000-000000000004', tenant_id: SEED.tenantId, email: noRolesEmail, display_name: 'No Roles', password_hash: hashSecret(SEED.password) })
      .execute();
    const login = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: noRolesEmail, password: SEED.password });
    expect(login.status).toBe(201);
    const noRoleToken = login.body.accessToken;

    const clash = 'abababab-0005-4000-8000-000000000005';
    const res = await request(app.getHttpServer())
      .post('/v1/sync/push')
      .set('authorization', `Bearer ${noRoleToken}`)
      .send({ commands: [openCommand('abadab0f-0005-4000-8000-000000000005', clash)] });
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('FORBIDDEN');
    expect(res.body.results[0].message).toMatch(/cash\.shift\.open/);

    // And the drawer it tried to open does not exist.
    const row = await dbs.db.selectFrom('cash_sessions').selectAll().where('id', '=', clash).executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
