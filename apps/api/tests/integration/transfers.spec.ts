import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

/**
 * Cross-branch transfers (item 4.7, ADR 0008).
 *
 * The property under test is the one sentence the phase is judged by: **stock is in exactly one
 * branch or in transit, never both**. Every test below that dispatches then counts the goods up
 * across branches, so a design that lets a document hold stock somewhere while a branch also holds
 * it fails the suite even if each individual write looks reasonable.
 *
 * Three owner decisions shape the refusals asserted here (item 4.7):
 *   1. every shortage needs a supervisor note before it can be received,
 *   2. receiving MORE than was sent is refused — that is a supplier receipt, not a transfer,
 *   3. a device reads only the transfers its own branch is party to (ADR 0008 item 5).
 */
describe('stock transfers — dispatch, receipt and discrepancy (item 4.7, ADR 0008)', () => {
  let app: INestApplication;
  let dbs: DbService;

  const sourceDeviceId = '99999999-9999-4999-8999-999999999996';
  const destDeviceId = '99999999-9999-4999-8999-999999999997';
  const sourceBranchId = SEED.branchId;
  const destBranchId = SEED.westBranchId;
  const thirdBranchId = '22222222-2222-4222-8222-222222222224';

  /** Owner signed in on the dispatching till, the receiving till, and with no device at all. */
  let sourceToken: string;
  let destToken: string;
  let deskToken: string;
  let cashierToken: string;

  const auth = (token: string, req: request.Test) => req.set('authorization', `Bearer ${token}`);
  const push = (token: string, command: unknown) =>
    auth(token, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });
  const list = (token: string, query: string) => auth(token, request(app.getHttpServer()).get(`/v1/inventory/transfers?${query}`));

  let seq = 0;
  const id = (head: string) => `${head}${String((seq += 1)).padStart(12, '0')}`;
  const TRANSFER_HEAD = 'aaaa2222-1111-4111-8111-';
  const COMMAND_HEAD = 'bbbb2222-1111-4111-8111-';

  const dispatchCommand = (opts: {
    transferId: string;
    toBranchId: string;
    lines: Array<Record<string, unknown>>;
    branchId?: string;
    deviceId?: string;
    extra?: Record<string, unknown>;
  }) => ({
    commandId: id(COMMAND_HEAD),
    branchId: opts.branchId ?? sourceBranchId,
    deviceId: opts.deviceId ?? sourceDeviceId,
    aggregateType: 'StockTransfer',
    aggregateId: opts.transferId,
    schemaVersion: 1,
    payload: {
      action: 'dispatch',
      transfer: { id: opts.transferId, toBranchId: opts.toBranchId, lines: opts.lines, ...(opts.extra ?? {}) },
    },
  });

  const receiveCommand = (opts: {
    transferId: string;
    lines: Array<Record<string, unknown>>;
    branchId?: string;
    deviceId?: string;
    extra?: Record<string, unknown>;
  }) => ({
    commandId: id(COMMAND_HEAD),
    branchId: opts.branchId ?? destBranchId,
    deviceId: opts.deviceId ?? destDeviceId,
    aggregateType: 'StockTransfer',
    aggregateId: opts.transferId,
    schemaVersion: 1,
    payload: { action: 'receive', transfer: { id: opts.transferId, lines: opts.lines, ...(opts.extra ?? {}) } },
  });

  const balanceAt = async (productId: string, branchId: string) => {
    const row = await dbs.db
      .selectFrom('stock_balances')
      .select('quantity')
      .where('product_id', '=', productId)
      .where('branch_id', '=', branchId)
      .executeTakeFirst();
    return Number(row?.quantity ?? 0);
  };

  /** Stock counted in both branches at once would show up here as more than was ever held. */
  const totalAcrossBranches = async (productId: string) => {
    const rows = await dbs.db.selectFrom('stock_balances').select(['branch_id', 'quantity']).where('product_id', '=', productId).execute();
    return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
  };

  const transferRow = (transferId: string) =>
    dbs.db.selectFrom('stock_transfers').selectAll().where('id', '=', transferId).executeTakeFirst();

  const transferLines = (transferId: string) =>
    dbs.db.selectFrom('stock_transfer_lines').selectAll().where('transfer_id', '=', transferId).execute();

  const movementsFor = (sourceId: string, reason?: string) => {
    let query = dbs.db.selectFrom('inventory_movements').selectAll().where('source_id', '=', sourceId);
    if (reason) query = query.where('reason', '=', reason);
    return query.execute();
  };

  const conflictCodes = async (commandId: string) => {
    const rows = await dbs.db.selectFrom('conflict_cases').select('code').where('command_id', '=', commandId).execute();
    return rows.map((r) => r.code);
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    // The seed already ships Main Kiosk and West Kiosk (the demo's transfer pair, item 4.7); SOUTH
    // is the extra one — a branch the reading device is NOT party to, so a list it could wrongly
    // reach across shows up as a difference in a test rather than in a shop.
    await dbs.db
      .insertInto('branches')
      .values([{ id: thirdBranchId, tenant_id: SEED.tenantId, code: 'SOUTH', name: 'South Kiosk' }])
      .execute();

    const base = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${base.body.accessToken}`)
      .send({ deviceId: sourceDeviceId, branchId: sourceBranchId, name: 'Main till' });
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${base.body.accessToken}`)
      .send({ deviceId: destDeviceId, branchId: destBranchId, name: 'West till' });

    sourceToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId: sourceDeviceId }))
      .body.accessToken;
    destToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId: destDeviceId }))
      .body.accessToken;
    cashierToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId: sourceDeviceId }))
      .body.accessToken;
    deskToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  // --- dispatch -----------------------------------------------------------------------------

  it('dispatches stock out of the source branch and holds it in transit — never counted in both', async () => {
    const transferId = id(TRANSFER_HEAD);
    const dispatch = await push(
      sourceToken,
      dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productA, quantity: 6 }] }),
    ).expect(201);

    expect(dispatch.body.results[0]).toMatchObject({ status: 'accepted', result: { transferId, reference: 'TRF-0001', lineCount: 1 } });

    // The source is 6 lighter, the destination has nothing yet, and the sum of every branch is
    // LESS than the shop held — the difference is the document's, held in transit.
    expect(await balanceAt(SEED.productA, sourceBranchId)).toBe(18);
    expect(await balanceAt(SEED.productA, destBranchId)).toBe(0);
    expect(await totalAcrossBranches(SEED.productA)).toBe(18);

    const document = await transferRow(transferId);
    expect(document).toMatchObject({
      reference: 'TRF-0001',
      status: 'dispatched',
      from_branch_id: sourceBranchId,
      to_branch_id: destBranchId,
      line_count: 1,
      received_at: null,
    });

    // The dispatch is one movement at the source that leaves NO cost of goods sold behind: the
    // goods did not stop being the shop's property, they stopped being this branch's stock.
    const [out] = await movementsFor(transferId, 'transfer_out');
    expect(out).toMatchObject({ branch_id: sourceBranchId, quantity_delta: -6, source_type: 'stock_transfer', cogs_minor: null });
    expect(await totalAcrossBranches(SEED.productA)).toBe(18);

    // What travelled is the FIFO cost of the six units: 6 × 4500, drawn from the layer.
    const line = (await transferLines(transferId))[0];
    expect(Number(line.unit_cost_minor)).toBe(4500);
    const allocations = await dbs.db.selectFrom('inventory_cost_allocations').selectAll().where('movement_id', '=', out.id).execute();
    expect(allocations.reduce((s, a) => s + Number(a.amount_minor), 0)).toBe(27000);

    // The receiving till can see it as its own inbound work, and its own list is the only place
    // this device can look.
    const inbound = await list(destToken, `branchId=${destBranchId}`).expect(200);
    expect(inbound.body.transfers).toHaveLength(1);
    expect(inbound.body.transfers[0]).toMatchObject({
      reference: 'TRF-0001',
      status: 'dispatched',
      inTransitQuantity: 6,
      fromBranchName: 'Main Kiosk',
      toBranchName: 'West Kiosk',
      lines: [{ productId: SEED.productA, sku: 'SKU-001', dispatched: 6, received: null, shortage: 0 }],
    });
  });

  it('receives the goods into the destination branch at the cost that travelled, closing the document', async () => {
    const transferId = id(TRANSFER_HEAD);
    const shopBefore = await totalAcrossBranches(SEED.productA);
    await push(sourceToken, dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productA, quantity: 4 }] })).expect(201);

    // Four more units in transit: held by NO branch, only by the document.
    expect(await totalAcrossBranches(SEED.productA)).toBe(shopBefore - 4);

    const receipt = await push(destToken, receiveCommand({ transferId, lines: [{ productId: SEED.productA, quantityReceived: 4 }] })).expect(201);
    expect(receipt.body.results[0]).toMatchObject({ status: 'accepted', result: { status: 'received', reference: 'TRF-0002', shortageQuantity: 0 } });

    // Back in exactly one branch — the receiving one — and worth what the source gave up.
    expect(await balanceAt(SEED.productA, destBranchId)).toBe(4);
    expect(await totalAcrossBranches(SEED.productA)).toBe(shopBefore);

    const [inMovement] = await movementsFor(transferId, 'transfer_in');
    expect(inMovement).toMatchObject({ branch_id: destBranchId, quantity_delta: 4, cogs_minor: null });
    const layer = await dbs.db
      .selectFrom('inventory_valuation_layers')
      .selectAll()
      .where('source_movement_id', '=', inMovement.id)
      .executeTakeFirst();
    expect(layer).toMatchObject({ branch_id: destBranchId, unit_cost_minor: 4500, quantity_received: 4, quantity_remaining: 4 });

    const document = await transferRow(transferId);
    expect(document).toMatchObject({ status: 'received', received_at: expect.anything(), approval_note: null });
    expect((await transferLines(transferId))[0].quantity_received).toBe(4);

    // Nothing is in transit any more, and both halves of the document are on the audit trail.
    const closed = await list(destToken, `branchId=${destBranchId}`).expect(200);
    expect(closed.body.transfers.find((t: { id: string }) => t.id === transferId)).toMatchObject({ status: 'received', inTransitQuantity: 0 });
    const actions = await dbs.db.selectFrom('audit_events').select('action').where('aggregate_id', '=', transferId).execute();
    expect(actions.map((a) => a.action).sort()).toEqual(['stock.transfer.dispatched', 'stock.transfer.received']);
  });

  it('issues each reference once, from a tenant-wide series', async () => {
    const first = id(TRANSFER_HEAD);
    await push(sourceToken, dispatchCommand({ transferId: first, toBranchId: destBranchId, lines: [{ productId: SEED.productB, quantity: 1 }] })).expect(201);
    const second = id(TRANSFER_HEAD);
    await push(sourceToken, dispatchCommand({ transferId: second, toBranchId: destBranchId, lines: [{ productId: SEED.productB, quantity: 1 }] })).expect(201);

    const references = [(await transferRow(first))?.reference, (await transferRow(second))?.reference];
    expect(references).toEqual(['TRF-0003', 'TRF-0004']);
  });

  // --- what dispatch refuses -----------------------------------------------------------------

  it('refuses to send more stock than this branch has, and says how many are there', async () => {
    const transferId = id(TRANSFER_HEAD);
    const command = dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productA, quantity: 5000 }] });
    const res = await push(sourceToken, command).expect(201);

    expect(res.body.results[0]).toMatchObject({
      status: 'rejected',
      code: 'INSUFFICIENT_STOCK',
      message: expect.stringContaining('SKU-001'),
    });
    expect(await conflictCodes(command.commandId)).toEqual(['NEGATIVE_STOCK']);
    expect(await transferRow(transferId)).toBeUndefined();
    expect(await movementsFor(transferId)).toHaveLength(0);
  });

  it('lets a supervisor note send into negative stock, and flags the result for review', async () => {
    // Its own product: sending into negative stock is meant to end badly, and the rest of the
    // suite still needs its opening stock where the seed left it.
    const sodaId = '88888888-8888-4888-8888-888888888809'; // SKU-009, 36 on hand
    const before = await balanceAt(sodaId, sourceBranchId);
    const transferId = id(TRANSFER_HEAD);
    const command = dispatchCommand({
      transferId,
      toBranchId: destBranchId,
      lines: [{ productId: sodaId, quantity: 50 }],
      extra: { approvedBy: SEED.ownerId, approvalNote: 'Counted into the van, receipt still at head office' },
    });
    const res = await push(sourceToken, command).expect(201);

    // accepted as a decision, but never as an ordinary success: the device shows it under
    // "needs attention" exactly like a negative adjustment.
    expect(res.body.results[0]).toMatchObject({ status: 'review_required', result: { negative: true } });
    expect(await conflictCodes(command.commandId)).toEqual(['NEGATIVE_STOCK']);
    expect(await balanceAt(sodaId, sourceBranchId)).toBe(before - 50);
    expect(await transferRow(transferId)).toMatchObject({
      status: 'dispatched',
      approval_note: 'Counted into the van, receipt still at head office',
      approved_by: SEED.ownerId,
    });
  });

  it('refuses a transfer to this same branch', async () => {
    const transferId = id(TRANSFER_HEAD);
    const res = await push(sourceToken, dispatchCommand({ transferId, toBranchId: sourceBranchId, lines: [{ productId: SEED.productA, quantity: 1 }] })).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'SAME_BRANCH' });
    expect(await transferRow(transferId)).toBeUndefined();
  });

  it('refuses a transfer to a branch this shop does not have', async () => {
    const transferId = id(TRANSFER_HEAD);
    const res = await push(
      sourceToken,
      dispatchCommand({ transferId, toBranchId: '22222222-2222-4222-8222-ffffffffffff', lines: [{ productId: SEED.productA, quantity: 1 }] }),
    ).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_BRANCH' });
    expect(await transferRow(transferId)).toBeUndefined();
  });

  it('refuses a transfer written against a branch this device is not enrolled against (ADR 0008 item 5)', async () => {
    const transferId = id(TRANSFER_HEAD);
    const res = await push(
      sourceToken,
      dispatchCommand({ transferId, toBranchId: destBranchId, branchId: destBranchId, deviceId: sourceDeviceId, lines: [{ productId: SEED.productA, quantity: 1 }] }),
    ).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'BRANCH_MISMATCH' });
    expect(await transferRow(transferId)).toBeUndefined();
  });

  it('refuses a transfer from a role without the inventory.transfer permission', async () => {
    const transferId = id(TRANSFER_HEAD);
    const res = await push(cashierToken, dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productA, quantity: 1 }] })).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'FORBIDDEN', message: expect.stringContaining('inventory.transfer') });
    expect(await transferRow(transferId)).toBeUndefined();
  });

  it('refuses a line written in a pack size the product does not have, before creating the document', async () => {
    const transferId = id(TRANSFER_HEAD);
    const res = await push(
      sourceToken,
      dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productA, quantity: 2, unit: 'crate' }] }),
    ).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_CONVERSION' });
    expect(await transferRow(transferId)).toBeUndefined();
  });

  // --- units and cost on the move ------------------------------------------------------------

  it('moves a pack quantity as base units while remembering what the paperwork said', async () => {
    const sodaId = '88888888-8888-4888-8888-888888888808'; // SKU-008, 1 crate = 24 ea, 48 on hand
    const transferId = id(TRANSFER_HEAD);
    const res = await push(
      sourceToken,
      dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: sodaId, quantity: 2, unit: 'crate' }] }),
    ).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'accepted' });

    expect(await balanceAt(sodaId, sourceBranchId)).toBe(0);
    const line = (await transferLines(transferId))[0];
    expect(line).toMatchObject({ unit: 'ea', entered_unit: 'crate', entered_quantity: 2, quantity_dispatched: 48 });
    const [out] = await movementsFor(transferId, 'transfer_out');
    // A movement's entered pair is SIGNED with its delta (−2 crates, exactly like an adjustment),
    // while the document line is simply the quantity of goods that went out.
    expect(out).toMatchObject({ quantity_delta: -48, entered_unit: 'crate', entered_quantity: -2, cogs_minor: null });

    // The receiving branch counts in base units (it has no crate of its own) and opens its layer at
    // the cost per bottle the source was carrying: 5500, not the crate's implied price.
    const receipt = await push(destToken, receiveCommand({ transferId, lines: [{ productId: sodaId, quantityReceived: 48 }] })).expect(201);
    expect(receipt.body.results[0]).toMatchObject({ status: 'accepted', result: { status: 'received' } });
    expect(await balanceAt(sodaId, destBranchId)).toBe(48);
    expect(Number((await transferLines(transferId))[0].unit_cost_minor)).toBe(5500);
    expect(await totalAcrossBranches(sodaId)).toBe(48);
  });

  // --- receipt refusals ----------------------------------------------------------------------

  it('refuses a short receipt until a supervisor note explains it, then records the discrepancy', async () => {
    const transferId = id(TRANSFER_HEAD);
    // Captured BEFORE the dispatch: the shop's total falls by the four sent and then by nothing
    // else, so the only thing that can shrink it again is a shortage nobody counted.
    const shopBefore = await totalAcrossBranches(SEED.productB);
    await push(sourceToken, dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productB, quantity: 4 }] })).expect(201);
    const destBefore = await balanceAt(SEED.productB, destBranchId);

    // 1. No note: refused outright, and nothing is written — not a movement, not a line count.
    //    The exception IS recorded: those four units physically stand in West while the ledger
    //    still holds them in transit, and nobody should be left to notice that at month end.
    const refused = await push(destToken, receiveCommand({ transferId, lines: [{ productId: SEED.productB, quantityReceived: 3 }] })).expect(201);
    const refusedCommand = refused.body.results[0];
    expect(refusedCommand).toMatchObject({ status: 'rejected', code: 'OVERRIDE_REQUIRED' });
    expect(await conflictCodes((refusedCommand as { commandId?: string }).commandId ?? '')).toEqual(['TRANSFER_SHORTAGE']);
    expect(await balanceAt(SEED.productB, destBranchId)).toBe(destBefore);
    expect((await transferLines(transferId))[0].quantity_received).toBeNull();
    expect((await transferRow(transferId))?.status).toBe('dispatched');

    // 2. With a note: received, but as a discrepancy — needs attention, shortage named and valued.
    const command = receiveCommand({ transferId, lines: [{ productId: SEED.productB, quantityReceived: 3 }], extra: { approvalNote: 'One carton crushed in transit — West counted 3 of 4', approvedBy: SEED.ownerId } });
    const accepted = await push(destToken, command).expect(201);
    expect(accepted.body.results[0]).toMatchObject({
      status: 'review_required',
      result: { status: 'discrepancy', shortageQuantity: 1, shortageValueMinor: 4000 },
    });
    expect(await conflictCodes(command.commandId)).toEqual(['TRANSFER_SHORTAGE']);

    expect(await balanceAt(SEED.productB, destBranchId)).toBe(destBefore + 3);
    // The unit nobody counted is gone from BOTH branches — it exists only as the discrepancy on
    // the document, which is why a shortage is approved rather than absorbed.
    expect(await totalAcrossBranches(SEED.productB)).toBe(shopBefore - 1);
    expect(await transferRow(transferId)).toMatchObject({ status: 'discrepancy', approval_note: expect.stringContaining('crushed') });
    expect((await transferLines(transferId))[0]).toMatchObject({ quantity_dispatched: 4, quantity_received: 3 });
  });

  it('refuses to receive more stock than the document sent', async () => {
    const transferId = id(TRANSFER_HEAD);
    await push(sourceToken, dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productB, quantity: 2 }] })).expect(201);
    const destBefore = await balanceAt(SEED.productB, destBranchId);

    const res = await push(destToken, receiveCommand({ transferId, lines: [{ productId: SEED.productB, quantityReceived: 3 }] })).expect(201);
    expect(res.body.results[0]).toMatchObject({
      status: 'rejected',
      code: 'RECEIVED_MORE_THAN_SENT',
      message: expect.stringContaining('supplier receipt'),
    });
    expect(await balanceAt(SEED.productB, destBranchId)).toBe(destBefore);
    expect((await transferRow(transferId))?.status).toBe('dispatched');
  });

  it('refuses a receipt from the branch that sent the goods', async () => {
    const transferId = id(TRANSFER_HEAD);
    await push(sourceToken, dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productA, quantity: 2 }] })).expect(201);

    const res = await push(sourceToken, receiveCommand({ transferId, branchId: sourceBranchId, deviceId: sourceDeviceId, lines: [{ productId: SEED.productA, quantityReceived: 2 }] })).expect(201);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'NOT_TRANSFER_DESTINATION' });
    expect((await transferRow(transferId))?.status).toBe('dispatched');
  });

  it('refuses a receipt that does not account for every line — or that invents one', async () => {
    const transferId = id(TRANSFER_HEAD);
    // Two lines on the document, so "incomplete" and "invented" are both possible.
    await push(
      sourceToken,
      dispatchCommand({
        transferId,
        toBranchId: destBranchId,
        lines: [
          { productId: SEED.productA, quantity: 2 },
          { productId: SEED.productB, quantity: 1 },
        ],
      }),
    ).expect(201);

    // Counting one of the two lines leaves the other unaccounted for: the server will not decide
    // that SKU-002 arrived.
    const omitted = await push(destToken, receiveCommand({ transferId, lines: [{ productId: SEED.productA, quantityReceived: 2 }] })).expect(201);
    expect(omitted.body.results[0]).toMatchObject({ status: 'rejected', code: 'MISSING_RECEIPT_LINE', message: expect.stringContaining('SKU-002') });

    // A line the document never carried is a count of something else entirely.
    const invented = await push(
      destToken,
      receiveCommand({
        transferId,
        lines: [
          { productId: SEED.productA, quantityReceived: 2 },
          { productId: SEED.productB, quantityReceived: 1 },
          { productId: '88888888-8888-4888-8888-888888888803', quantityReceived: 1 },
        ],
      }),
    ).expect(201);
    expect(invented.body.results[0]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_RECEIPT_LINE' });
    expect((await transferRow(transferId))?.status).toBe('dispatched');
  });

  it('refuses to receive the same transfer twice', async () => {
    const transferId = id(TRANSFER_HEAD);
    await push(sourceToken, dispatchCommand({ transferId, toBranchId: destBranchId, lines: [{ productId: SEED.productA, quantity: 2 }] })).expect(201);
    await push(destToken, receiveCommand({ transferId, lines: [{ productId: SEED.productA, quantityReceived: 2 }] })).expect(201);

    const again = await push(destToken, receiveCommand({ transferId, lines: [{ productId: SEED.productA, quantityReceived: 2 }] })).expect(201);
    expect(again.body.results[0]).toMatchObject({ status: 'rejected', code: 'ALREADY_RECEIVED' });
  });

  // --- reading the list ----------------------------------------------------------------------

  it('shows each device only the transfers its own branch is party to', async () => {
    // A transfer between two OTHER branches — the reading device has no business seeing it.
    const away = id(TRANSFER_HEAD);
    await push(destToken, dispatchCommand({ transferId: away, toBranchId: thirdBranchId, branchId: destBranchId, deviceId: destDeviceId, lines: [{ productId: SEED.productA, quantity: 1 }] })).expect(201);

    const mine = await list(sourceToken, `branchId=${sourceBranchId}`).expect(200);
    expect(mine.body.transfers.length).toBeGreaterThan(0);
    expect(mine.body.transfers.every((t: { fromBranchId: string; toBranchId: string }) => t.fromBranchId === sourceBranchId || t.toBranchId === sourceBranchId)).toBe(true);
    expect(mine.body.transfers.some((t: { id: string }) => t.id === away)).toBe(false);

    const theirs = await list(destToken, `branchId=${destBranchId}`).expect(200);
    expect(theirs.body.transfers.some((t: { id: string }) => t.id === away)).toBe(true);

    // A till may not read another branch's transfers, whoever is holding it…
    const crossed = await list(sourceToken, `branchId=${destBranchId}`).expect(403);
    expect(crossed.body).toMatchObject({ code: 'BRANCH_MISMATCH' });

    // …but a session with no device is not a till: it is an operator at a desk, free to read any
    // branch of its own tenant (the Phase 9 owner view stands on this).
    const desk = await list(deskToken, `branchId=${destBranchId}`).expect(200);
    expect(desk.body.transfers.some((t: { id: string }) => t.id === away)).toBe(true);

    // And a cashier, who cannot move stock at all, does not get the list either.
    const forCashier = await list(cashierToken, `branchId=${sourceBranchId}`).expect(403);
    expect(forCashier.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a transfer list request with no branch to read', async () => {
    const res = await list(sourceToken, '').expect(422);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
