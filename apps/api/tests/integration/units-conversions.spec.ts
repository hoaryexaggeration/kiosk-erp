import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED, DEMO_UNITS } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

/**
 * Item 4.6 — units of measure, pack sizes and brands.
 *
 * Two claims are under test, and only two:
 *   1. a pack size is a fact about ONE product ("1 crate = 24 bottles" for soda, 12 for water), and
 *      the catalogue refuses to write one that could not describe a pack;
 *   2. stock bought in crates and sold in pieces lands in ONE ledger — every movement the server
 *      records is in the product's base unit, and the pack it arrived as is remembered beside it.
 *
 * The second claim is the one the phase states as its exit criterion, so it is checked against the
 * valuation layers and the balances, not only against the response of the command that was sent.
 */
describe('units, pack sizes and brands (Phase 4, item 4.6)', () => {
  let dbs: DbService;
  let app: INestApplication;
  const deviceId = '99999999-9999-4999-8999-999999999997';
  let ownerToken: string;
  let cashierToken: string;

  const auth = (token: string, req: request.Test) => req.set('authorization', `Bearer ${token}`);
  const push = (token: string, command: unknown) => auth(token, request(app.getHttpServer()).post('/v1/sync/push')).send({ commands: [command] });

  const productBySku = async (sku: string) =>
    (await dbs.db.selectFrom('products').selectAll().where('sku', '=', sku).executeTakeFirst()) ?? null;

  const balanceOf = async (productId: string) => {
    const row = await dbs.db.selectFrom('stock_balances').selectAll().where('product_id', '=', productId).executeTakeFirst();
    return Number(row?.quantity ?? 0);
  };

  // Heads are exactly 24 characters, so appending a 12-digit serial yields a valid UUID.
  let seq = 0;
  const nextUuid = (head: string) => `${head}${String((seq += 1)).padStart(12, '0')}`;

  const receipt = (lines: Array<{ productId: string; quantity: number; unit?: string; unitCostMinor?: number }>) => {
    const id = nextUuid('aaaa2222-2222-4222-8222-');
    return {
      commandId: nextUuid('bbbb2222-2222-4222-8222-'),
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'StockReceipt',
      aggregateId: id,
      schemaVersion: 1,
      payload: { receipt: { id, reason: 'grn', lines } },
    };
  };

  const adjustment = (lines: Array<{ productId: string; quantityDelta: number; unit?: string }>, extra: Record<string, unknown> = {}) => {
    const id = nextUuid('cccc2222-2222-4222-8222-');
    return {
      commandId: nextUuid('dddd2222-2222-4222-8222-'),
      branchId: SEED.branchId,
      deviceId,
      aggregateType: 'StockAdjustment',
      aggregateId: id,
      schemaVersion: 1,
      payload: { adjustment: { id, reason: 'stocktake', lines, ...extra } },
    };
  };

  beforeAll(async () => {
    const ctx: TestContext = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;

    const base = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${base.body.accessToken}`)
      .send({ deviceId, branchId: SEED.branchId, name: 'Unit till' });

    ownerToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
    cashierToken = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password, deviceId })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the unit catalogue', () => {
    it('seeds units whose kind decides what the ledger will accept for a base unit', async () => {
      const res = await auth(ownerToken, request(app.getHttpServer()).get('/v1/units'));
      expect(res.status).toBe(200);
      const codes = new Map(res.body.units.map((u: { code: string; kind: string }) => [u.code, u.kind]));
      expect(res.body.units.length).toBe(DEMO_UNITS.length);
      expect(codes.get('ea')).toBe('count');
      expect(codes.get('crate')).toBe('count');
      expect(codes.get('kg')).toBe('weight');
      expect(codes.get('ml')).toBe('volume');
    });

    it('adds a unit, and refuses a second spelling of one that already exists', async () => {
      const created = await auth(ownerToken, request(app.getHttpServer()).post('/v1/units')).send({ code: 'sack', name: 'Sack', kind: 'count' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: 'sack', name: 'Sack', kind: 'count' });

      const duplicate = await auth(ownerToken, request(app.getHttpServer()).post('/v1/units')).send({ code: 'SACK', name: 'Sack', kind: 'count' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('DUPLICATE_UNIT');
    });

    it('treats a unit as configuration a cashier may read but not create', async () => {
      const asCashier = await auth(cashierToken, request(app.getHttpServer()).post('/v1/units')).send({ code: 'bale', name: 'Bale', kind: 'count' });
      expect(asCashier.status).toBe(403);
      expect(asCashier.body.code).toBe('FORBIDDEN');
    });

    it('rejects a kind the ledger has no rule for', async () => {
      const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/units')).send({ code: 'box', name: 'Box', kind: 'mass' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('ships both vocabularies to a device in the config snapshot', async () => {
      // A device resolves a pack size offline from this snapshot (§6), so units and brands have to
      // travel with categories and tax rates rather than being fetched on demand.
      const res = await auth(ownerToken, request(app.getHttpServer()).get('/v1/config/snapshot'));
      expect(res.status).toBe(200);
      expect(res.body.units.map((u: { code: string }) => u.code)).toEqual(expect.arrayContaining(['ea', 'crate', 'kg']));
      expect(res.body.units.every((u: { kind: string }) => ['count', 'weight', 'volume'].includes(u.kind))).toBe(true);
      expect(res.body.brands.map((b: { name: string }) => b.name)).toEqual(
        expect.arrayContaining(['Savannah Foods', 'Kaskazi Drinks', 'Neema Home']),
      );
    });
  });

  describe('brands', () => {
    it('lists the seeded brands and creates one, refusing a case-variant of it', async () => {
      const seeded = await auth(ownerToken, request(app.getHttpServer()).get('/v1/brands'));
      expect(seeded.status).toBe(200);
      expect(seeded.body.brands.map((b: { name: string }) => b.name).sort()).toEqual(['Kaskazi Drinks', 'Neema Home', 'Savannah Foods']);

      const created = await auth(ownerToken, request(app.getHttpServer()).post('/v1/brands')).send({ name: 'Nuru Mills' });
      expect(created.status).toBe(201);

      const duplicate = await auth(ownerToken, request(app.getHttpServer()).post('/v1/brands')).send({ name: 'nuru MILLS' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('DUPLICATE_BRAND');
    });

    it('refuses a brand from another shop rather than pointing a product at it', async () => {
      const brands = await auth(ownerToken, request(app.getHttpServer()).get('/v1/brands'));
      const brandId = brands.body.brands.find((b: { name: string }) => b.name === 'Nuru Mills').id as string;
      expect(brandId).toBeTruthy();

      const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-XREF',
        name: 'Somebody else’s brand',
        unit: 'ea',
        brandId: '11111111-1111-4111-8111-111111119999',
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNKNOWN_BRAND');
      expect(await productBySku('UOM-XREF')).toBeNull();
    });
  });

  describe('pack sizes on a product', () => {
    const brandIdOf = async (name: string) =>
      (await auth(ownerToken, request(app.getHttpServer()).get('/v1/brands'))).body.brands.find((b: { name: string }) => b.name === name).id as string;

    it('ships the base unit’s kind with the product so a device can convert by the right rule offline', async () => {
      const listed = async () => {
        const res = await auth(ownerToken, request(app.getHttpServer()).get('/v1/products?limit=500'));
        return res.body.products.find((product: { sku: string }) => product.sku === 'SKU-008');
      };

      // The three things a device needs to convert a receipt while the shop is offline, together on
      // the payload that already carries the pack sizes (item 4.6, §6).
      expect(await listed()).toMatchObject({
        unit: 'ea',
        unit_kind: 'count',
        conversions: [{ unit: 'crate', factor: 24 }],
      });

      // A unit nobody typed into the vocabulary has no rule at all: reported as null, never guessed,
      // because guessing `count` would stop a legal weigh the moment somebody forgot to add "gm".
      const created = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-007',
        name: 'Product in an unlisted unit',
        unit: 'btl',
        priceMinor: 100,
        costMinor: 50,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ unit: 'btl', unit_kind: null });

      const weighed = await auth(ownerToken, request(app.getHttpServer()).get('/v1/products?limit=500'));
      expect(weighed.body.products.find((product: { sku: string }) => product.sku === 'SKU-011')).toMatchObject({
        unit: 'kg',
        unit_kind: 'weight',
      });
    });

    it('stores a conversion set as a SET, exactly like barcodes', async () => {
      // The brand is fetched BEFORE the request object exists: creating a supertest request and then
      // awaiting something else lets its shared server settle and close underneath the pending call.
      const brandId = await brandIdOf('Nuru Mills');
      const created = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-001',
        name: 'Biscuits',
        unit: 'ea',
        priceMinor: 1000,
        costMinor: 600,
        brandId,
        barcodes: ['6009000001013'],
        conversions: [
          { unit: 'crate', factor: 24 },
          { unit: 'pack', factor: 6 },
        ],
      });
      expect(created.status).toBe(201);
      // Ordered by unit, so a device caches them deterministically.
      expect(created.body.conversions).toEqual([
        { unit: 'crate', factor: 24 },
        { unit: 'pack', factor: 6 },
      ]);
      expect(created.body.brand_name).toBe('Nuru Mills');

      const id = created.body.id as string;
      const replaced = await auth(ownerToken, request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ conversions: [{ unit: 'pack', factor: 12 }] });
      expect(replaced.body.conversions).toEqual([{ unit: 'pack', factor: 12 }]);

      // Absent means "leave it alone", the same rule as barcodes — a price edit cannot quietly
      // drop the pack sizes.
      const untouched = await auth(ownerToken, request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ name: 'Biscuits 200g' });
      expect(untouched.body.conversions).toEqual([{ unit: 'pack', factor: 12 }]);

      const listed = await auth(ownerToken, request(app.getHttpServer()).get('/v1/products?limit=100'));
      const fromList = listed.body.products.find((p: { sku: string }) => p.sku === 'UOM-001');
      expect(fromList).toMatchObject({ brand_name: 'Nuru Mills', conversions: [{ unit: 'pack', factor: 12 }] });
      expect(fromList.barcodes).toEqual(['6009000001013']);
    });

    it('refuses a pack naming a unit the catalogue does not know', async () => {
      const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-002',
        name: 'Water sachets',
        unit: 'ea',
        conversions: [{ unit: 'pallet', factor: 40 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_UNIT');
      expect(res.body.message).toContain('pallet');
      expect(await productBySku('UOM-002')).toBeNull();
    });

    it('refuses a pack that would convert the product into its own selling unit', async () => {
      const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-003',
        name: 'Sacks of sugar',
        unit: 'ea',
        conversions: [{ unit: 'ea', factor: 2 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SELF_CONVERSION');
    });

    it('refuses a factor that could not describe a pack at all', async () => {
      const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-004',
        name: 'Impossible pack',
        unit: 'ea',
        conversions: [{ unit: 'pack', factor: 0 }],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('refuses pack sizes while the selling unit itself is not in the catalogue', async () => {
      const res = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-005',
        name: 'Loose bottles',
        unit: 'btl',
        conversions: [{ unit: 'crate', factor: 12 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_UNIT');
      expect(res.body.message).toContain('btl');
    });

    it('refuses a selling unit change that would strand the pack sizes already stored', async () => {
      const created = await auth(ownerToken, request(app.getHttpServer()).post('/v1/products')).send({
        sku: 'UOM-006',
        name: 'Water 1L',
        unit: 'ea',
        conversions: [{ unit: 'crate', factor: 12 }],
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const untyped = await auth(ownerToken, request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ unit: 'btl' });
      expect(untyped.status).toBe(400);
      expect(untyped.body.code).toBe('UNKNOWN_UNIT');

      const self = await auth(ownerToken, request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ unit: 'crate' });
      expect(self.status).toBe(400);
      expect(self.body.code).toBe('SELF_CONVERSION');

      // The product still converts the way it did: a refusal writes nothing.
      expect(await productBySku('UOM-006')).toMatchObject({ unit: 'ea' });
      const stored = await dbs.db.selectFrom('unit_conversions').selectAll().where('product_id', '=', id).execute();
      expect(stored.map((row) => [row.unit, Number(row.factor)])).toEqual([['crate', 12]]);
    });
  });

  describe('one ledger across pack sizes', () => {
    it('records a receipt in crates as one base-unit movement, with the pack remembered', async () => {
      const soda = await productBySku('SKU-008');
      expect(soda).toBeTruthy();
      const openingBalance = await balanceOf(soda!.id);

      const res = await push(ownerToken, receipt([{ productId: soda!.id, quantity: 10, unit: 'crate', unitCostMinor: 24000 }]));
      expect(res.status).toBe(201); // `/sync/push` is a POST, and every command it accepted came back in one answer
      expect(res.body.results[0].status).toBe('accepted');

      // 10 crates of 24 bottles is 240 bottles, and 48 were already on the shelf.
      expect(await balanceOf(soda!.id)).toBe(openingBalance + 240);

      const movement = await dbs.db
        .selectFrom('inventory_movements')
        .selectAll()
        .where('product_id', '=', soda!.id)
        .where('source_type', '=', 'stock_receipt')
        .executeTakeFirstOrThrow();
      expect(Number(movement.quantity_delta)).toBe(240);
      expect(movement.unit).toBe('ea');
      // What the paperwork said, kept beside the fact rather than instead of it.
      expect(movement.entered_unit).toBe('crate');
      expect(Number(movement.entered_quantity)).toBe(10);

      // 24,000 a crate is 1,000 a bottle: the layer's cost follows the same factor as the quantity,
      // so what is valued equals what was invoiced (240 × 1,000 = 10 × 24,000).
      const layer = await dbs.db
        .selectFrom('inventory_valuation_layers')
        .selectAll()
        .where('product_id', '=', soda!.id)
        .where('source_movement_id', '=', movement.id)
        .executeTakeFirstOrThrow();
      expect(Number(layer.unit_cost_minor)).toBe(1000);
      expect(Number(layer.quantity_received)).toBe(240);
      expect(Number(layer.quantity_remaining) * Number(layer.unit_cost_minor)).toBe(10 * 24000);

      // The product's latest known cost is per BASE unit, so it is the converted figure too.
      expect(Number((await productBySku('SKU-008'))!.cost_minor)).toBe(1000);
    });

    it('reports the pack the receipt arrived in through the movement history', async () => {
      const soda = await productBySku('SKU-008');
      const res = await auth(ownerToken, request(app.getHttpServer()).get(`/v1/inventory/movements?productId=${soda!.id}`));
      expect(res.status).toBe(200);
      const converted = res.body.movements.find((m: { entered_unit: string | null }) => m.entered_unit === 'crate');
      expect(converted).toMatchObject({ unit: 'ea', entered_unit: 'crate', entered_quantity: 10, quantity_delta: 240 });
    });

    it('refuses a whole receipt when one line names a pack the product cannot convert', async () => {
      const eggs = await productBySku('SKU-013');
      const tomatoes = await productBySku('SKU-011');
      const eggsBefore = await balanceOf(eggs!.id);
      const tomatoesBefore = await balanceOf(tomatoes!.id);

      // The first line is perfectly valid on its own; nothing at all may be written.
      const res = await push(
        ownerToken,
        receipt([
          { productId: eggs!.id, quantity: 2, unit: 'tray', unitCostMinor: 48000 },
          { productId: tomatoes!.id, quantity: 1, unit: 'crate' },
        ]),
      );
      expect(res.body.results[0].status).toBe('rejected');
      expect(res.body.results[0].code).toBe('UNKNOWN_CONVERSION');
      expect(res.body.results[0].message).toContain('crate');

      expect(await balanceOf(eggs!.id)).toBe(eggsBefore);
      expect(await balanceOf(tomatoes!.id)).toBe(tomatoesBefore);
    });

    it('keeps a weighed product in kilograms however many grams arrived', async () => {
      const tomatoes = await productBySku('SKU-011');
      const before = await balanceOf(tomatoes!.id);

      const res = await push(ownerToken, receipt([{ productId: tomatoes!.id, quantity: 1250, unit: 'g', unitCostMinor: 80 }]));
      expect(res.body.results[0].status).toBe('accepted');

      expect(await balanceOf(tomatoes!.id)).toBe(before + 1.25);
      const layer = await dbs.db
        .selectFrom('inventory_valuation_layers')
        .selectAll()
        .where('product_id', '=', tomatoes!.id)
        .orderBy('received_at', 'desc')
        .executeTakeFirstOrThrow();
      // 80 per gram is 80,000 per kilogram — the same factor as the quantity, to the minor unit.
      expect(Number(layer.quantity_received)).toBe(1.25);
      expect(Number(layer.unit_cost_minor)).toBe(80000);
    });

    it('adjusts in crates and compares the supervisor override against the base quantity', async () => {
      const water = await productBySku('SKU-009');
      const before = await balanceOf(water!.id);

      const one = await push(ownerToken, adjustment([{ productId: water!.id, quantityDelta: -1, unit: 'crate' }]));
      expect(one.body.results[0].status).toBe('accepted');
      expect(await balanceOf(water!.id)).toBe(before - 12);

      // -4 crates is -48 bottles, which is MORE than the 24 left. Compared in the stated unit it
      // would look like -4 against 24 and slip through (§18.5: the till/server blocks negative).
      const tooFar = await push(ownerToken, adjustment([{ productId: water!.id, quantityDelta: -4, unit: 'crate' }]));
      expect(tooFar.body.results[0].status).toBe('rejected');
      expect(tooFar.body.results[0].code).toBe('OVERRIDE_REQUIRED');
      expect(await balanceOf(water!.id)).toBe(before - 12);

      // A supervisor may still post it, and the ledger then holds the base quantity and the pack.
      const override = await push(
        ownerToken,
        adjustment([{ productId: water!.id, quantityDelta: -4, unit: 'crate' }], {
          approvedBy: SEED.ownerId,
          approvalNote: 'Stocktake found an opened crate',
        }),
      );
      expect(override.body.results[0].status).toBe('review_required');
      expect(await balanceOf(water!.id)).toBe(before - 60);
      const movement = await dbs.db
        .selectFrom('inventory_movements')
        .selectAll()
        .where('product_id', '=', water!.id)
        .where('quantity_delta', '=', -48)
        .executeTakeFirstOrThrow();
      // The pack travels with the fact: -4 crates is written as -48 bottles, both numbers kept.
      expect(movement).toMatchObject({ unit: 'ea', quantity_delta: -48, entered_unit: 'crate', entered_quantity: -4 });
    });

    it('refuses an adjustment that would take a counted product to a fraction', async () => {
      const soda = await productBySku('SKU-008');
      const before = await balanceOf(soda!.id);

      const res = await push(ownerToken, adjustment([{ productId: soda!.id, quantityDelta: 1.3, unit: 'crate' }]));
      expect(res.body.results[0].status).toBe('rejected');
      expect(res.body.results[0].code).toBe('FRACTIONAL_QUANTITY');
      expect(await balanceOf(soda!.id)).toBe(before);
    });

    it('lets a weighed product take a fractional adjustment, because that is what was weighed', async () => {
      const tomatoes = await productBySku('SKU-011');
      const before = await balanceOf(tomatoes!.id);

      const res = await push(ownerToken, adjustment([{ productId: tomatoes!.id, quantityDelta: -125, unit: 'g' }]));
      expect(res.body.results[0].status).toBe('accepted');
      expect(await balanceOf(tomatoes!.id)).toBe(before - 0.125);
    });

    it('holds a counted product to whole numbers however the quantity is written', async () => {
      // In its OWN unit, with no pack in sight — the rule is about the base unit, not about crates.
      const soda = await productBySku('SKU-008');
      const before = await balanceOf(soda!.id);
      const refused = await push(ownerToken, receipt([{ productId: soda!.id, quantity: 0.5, unitCostMinor: 1000 }]));
      expect(refused.body.results[0]).toMatchObject({ status: 'rejected', code: 'FRACTIONAL_QUANTITY' });
      expect(await balanceOf(soda!.id)).toBe(before);

      // The same shape on a weighed product, whose unit IS typed: half a kilogram is an ordinary
      // receipt, and refusing it would be inventing a rule the shop never asked for.
      const tomatoes = await productBySku('SKU-011');
      const weighed = await balanceOf(tomatoes!.id);
      const accepted = await push(ownerToken, receipt([{ productId: tomatoes!.id, quantity: 0.5, unitCostMinor: 700 }]));
      expect(accepted.body.results[0].status).toBe('accepted');
      expect(await balanceOf(tomatoes!.id)).toBe(weighed + 0.5);
    });
  });
});
