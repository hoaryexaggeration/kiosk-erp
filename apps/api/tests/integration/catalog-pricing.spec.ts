import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { DbService } from '../../src/db/db.service';

describe('catalogue + price resolution (Phase 4)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let dbs: DbService;
  let token: string;
  const deviceId = '99999999-9999-4999-8999-999999999997';

  const auth = (req: request.Test) => req.set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    dbs = ctx.dbs;
    const admin = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    const adminToken = admin.body.accessToken;
    await request(app.getHttpServer())
      .post('/v1/devices/enroll')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ deviceId, branchId: SEED.branchId, name: 'Catalog test' });
    token = (await request(app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password, deviceId })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('exports real tax rates with the catalogue instead of a client default', async () => {
    const res = await auth(request(app.getHttpServer()).get('/v1/products'));
    expect(res.status).toBe(200);
    const product = res.body.products.find((p: { id: string }) => p.id === SEED.productA);
    expect(product).toBeDefined();
    expect(typeof product.tax_rate_bp).toBe('number');
    expect(typeof product.tax_inclusive).toBe('boolean');
  });

  // Devices must be able to resolve a scan offline, so the catalogue has to carry barcodes (§5).
  it('exports each product barcode with the catalogue so scans resolve offline', async () => {
    const res = await auth(request(app.getHttpServer()).get('/v1/products'));
    expect(res.status).toBe(200);
    const product = res.body.products.find((p: { id: string }) => p.id === SEED.productA);
    expect(Array.isArray(product.barcodes)).toBe(true);
    expect(product.barcodes).toContain('6001000000011');
  });

  it('creates a product and bumps the version on update with optimistic concurrency', async () => {
    const created = await auth(request(app.getHttpServer()).post('/v1/products')).send({
      sku: 'PH4-NEW-1',
      name: 'Phase 4 test product',
      taxCategoryId: SEED.taxCategoryId,
      priceMinor: 1000,
      barcodes: ['PH4001'],
    });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);
    expect(created.body.barcodes).toEqual(['PH4001']);
    const id = created.body.id as string;

    const updated = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ name: 'Renamed', priceMinor: 1500, expectedVersion: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    expect(updated.body.price_minor).toBe(1500);

    const stale = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ name: 'Nope', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_MISMATCH');
  });

  it('adds, replaces and removes barcodes on an existing product (item 4.1)', async () => {
    const created = await auth(request(app.getHttpServer()).post('/v1/products')).send({
      sku: 'PH4-BC-1',
      name: 'Barcode edit product',
      taxCategoryId: SEED.taxCategoryId,
      priceMinor: 900,
      barcodes: ['PH4BC01'],
    });
    const id = created.body.id as string;

    // Adding a barcode keeps the existing one.
    const added = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ barcodes: ['PH4BC01', 'PH4BC02'] });
    expect(added.status).toBe(200);
    expect(added.body.barcodes).toEqual(['PH4BC01', 'PH4BC02']);

    // The added barcode resolves, so the item is scannable without recreating it.
    const lookup = await auth(request(app.getHttpServer()).get('/v1/barcodes/PH4BC02'));
    expect(lookup.status).toBe(200);
    expect(lookup.body.id).toBe(id);

    // Replacing is a set operation: the removed barcode stops resolving entirely.
    const replaced = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ barcodes: ['PH4BC03'] });
    expect(replaced.body.barcodes).toEqual(['PH4BC03']);
    const gone = await auth(request(app.getHttpServer()).get('/v1/barcodes/PH4BC01'));
    expect(gone.status).toBe(404);

    // A barcode owned by another product is a conflict, never a silent steal.
    const clash = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ barcodes: ['6001000000011'] });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('DUPLICATE_BARCODE');
    const stillThere = await auth(request(app.getHttpServer()).get('/v1/barcodes/6001000000011'));
    expect(stillThere.body.id).toBe(SEED.productA);

    // Clearing every barcode is allowed.
    const cleared = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ barcodes: [] });
    expect(cleared.body.barcodes).toEqual([]);
  });

  it('carries the tax category through create and update so an edit cannot silently clear it', async () => {
    // The device caches `tax_category_id` and sends it back on save. If the payload omitted it, an
    // edit would send null and quietly drop the product's 16% VAT rate.
    const created = await auth(request(app.getHttpServer()).post('/v1/products')).send({
      sku: 'PH4-TAX-1',
      name: 'Tax category round trip',
      taxCategoryId: SEED.taxCategoryId,
      priceMinor: 11600,
    });
    expect(created.status).toBe(201);
    expect(created.body.tax_category_id).toBe(SEED.taxCategoryId);
    expect(created.body.tax_rate_bp).toBe(1600);
    const id = created.body.id as string;

    const renamed = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({
      name: 'Renamed but still taxed',
      taxCategoryId: SEED.taxCategoryId,
      expectedVersion: 1,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.tax_category_id).toBe(SEED.taxCategoryId);
    expect(renamed.body.tax_rate_bp).toBe(1600);

    // Clearing is still possible when it is asked for explicitly.
    const cleared = await auth(request(app.getHttpServer()).patch(`/v1/products/${id}`)).send({ taxCategoryId: null, expectedVersion: 2 });
    expect(cleared.body.tax_category_id).toBeNull();
    expect(cleared.body.tax_rate_bp).toBe(0);
  });

  it('pushes a product delta to devices as a server event', async () => {
    const events = await dbs.db
      .selectFrom('server_events')
      .selectAll()
      .where('tenant_id', '=', SEED.tenantId)
      .where('event_type', 'in', ['product.created', 'product.updated'])
      .execute();
    expect(events.length).toBeGreaterThanOrEqual(2);
    const payload = events[0].payload as Record<string, unknown>;
    // The client DTO the Android cache parses directly.
    expect(payload).toHaveProperty('sku');
    expect(payload).toHaveProperty('tax_rate_bp');
  });

  it('resolves list price, then an active promotion, as a function of asOf', async () => {
    const list = await auth(request(app.getHttpServer()).get(`/v1/pricing/resolve?productId=${SEED.productA}`));
    expect(list.status).toBe(200);
    expect(list.body.source).toBe('list');
    const base = list.body.unitPriceMinor as number;

    await dbs.db
      .insertInto('promotions')
      .values({ tenant_id: SEED.tenantId, name: '10% off', kind: 'percent_off', value: 1000, product_id: SEED.productA })
      .execute();

    const promoted = await auth(request(app.getHttpServer()).get(`/v1/pricing/resolve?productId=${SEED.productA}`));
    expect(promoted.body.source).toBe('promotion');
    expect(promoted.body.unitPriceMinor).toBe(Math.round(base * 0.9));

    // A promotion with no start date applies to any asOf.
    const past = await auth(
      request(app.getHttpServer()).get(`/v1/pricing/resolve?productId=${SEED.productA}&asOf=2000-01-01T00:00:00Z`),
    );
    expect(past.body.source).toBe('promotion');
  });
});
