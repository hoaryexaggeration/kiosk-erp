import request from 'supertest';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';

describe('auth — tokens, rotation, RBAC (Phase 2)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('rejects invalid credentials', async () => {
    const res = await request(ctx.app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('logs in and lists permissions from the token subject', async () => {
    const login = await request(ctx.app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    expect(login.status).toBe(201);
    const me = await request(ctx.app.getHttpServer()).get('/v1/auth/me').set('authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('license.manage');
  });

  it('enforces permissions server-side (cashier cannot manage devices)', async () => {
    const login = await request(ctx.app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.cashierEmail, password: SEED.password });
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/devices')
      .set('authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('rotates refresh tokens and detects reuse (revokes the family)', async () => {
    const login = await request(ctx.app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    const first = login.body.refreshToken as string;

    const rotated = await request(ctx.app.getHttpServer()).post('/v1/auth/refresh').send({ refreshToken: first });
    expect(rotated.status).toBe(201);
    expect(rotated.body.refreshToken).not.toBe(first);

    // Reusing the retired token must fail and revoke the whole family.
    const reuse = await request(ctx.app.getHttpServer()).post('/v1/auth/refresh').send({ refreshToken: first });
    expect(reuse.status).toBe(401);

    const afterRevoke = await request(ctx.app.getHttpServer()).post('/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(afterRevoke.status).toBe(401);
  });
});
