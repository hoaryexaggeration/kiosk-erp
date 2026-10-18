import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import request from 'supertest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { createTestApp, TestContext } from '../helpers/app';
import { SEED } from '../../src/db/seed-dev';
import { config } from '../../src/config';
import { resetSigningKeyCache } from '../../src/modules/licensing/license-keys';

describe('licensing — offline signed package (Phase 2/3)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    // Generate a throwaway ES256 signer for the test run (ADR 0003).
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    mkdirSync(dirname(config.LICENSE_SIGNING_PRIVATE_KEY_PATH), { recursive: true });
    writeFileSync(config.LICENSE_SIGNING_PRIVATE_KEY_PATH, await exportPKCS8(privateKey));
    writeFileSync(config.LICENSE_SIGNING_PUBLIC_KEY_PATH, await exportSPKI(publicKey));
    resetSigningKeyCache();

    ctx = await createTestApp();
    const login = await request(ctx.app.getHttpServer()).post('/v1/auth/login').send({ email: SEED.ownerEmail, password: SEED.password });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const auth = (req: request.Test) => req.set('authorization', `Bearer ${token}`);

  it('reports the perpetual core entitlement from the seed', async () => {
    const res = await auth(request(ctx.app.getHttpServer()).get('/v1/licensing/status'));
    expect(res.status).toBe(200);
    expect(res.body.perpetualCoreActive).toBe(true);
    expect(res.body.entitlements).toContain('core.pos');
  });

  it('creates a renewal request without leaking customer/sales data', async () => {
    const res = await auth(request(ctx.app.getHttpServer()).post('/v1/licensing/requests')).send({ requestedPlanId: 'core_maintenance_1y', requestedTermDays: 365 });
    expect(res.status).toBe(201);
    expect(res.body.nonce).toBeDefined();
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/customer|sale|password/i);
  });

  it('issues a JWS package that verifies, and rejects tampering', async () => {
    const issue = await auth(request(ctx.app.getHttpServer()).post('/v1/licensing/packages/issue')).send({ licenseId: SEED.licenseId });
    expect(issue.status).toBe(201);
    const jws: string = issue.body.jws;
    expect(jws.split('.')).toHaveLength(3); // compact JWS

    const verify = await auth(request(ctx.app.getHttpServer()).post('/v1/licensing/packages/verify')).send({ jws });
    expect(verify.status).toBe(201);
    expect(verify.body.licenseId).toBe(SEED.licenseId);
    expect(verify.body.perpetualCore).toBe(true);
    expect(verify.body.kid).toBe(config.LICENSE_SIGNING_KID);

    // Tamper with the payload segment -> signature must fail.
    const parts = jws.split('.');
    const tampered = [parts[0], Buffer.from(JSON.stringify({ hacked: true })).toString('base64url'), parts[2]].join('.');
    const bad = await auth(request(ctx.app.getHttpServer()).post('/v1/licensing/packages/verify')).send({ jws: tampered });
    expect(bad.status).toBe(422);
  });

  it('acknowledges an issued package after re-verifying it', async () => {
    const issue = await auth(request(ctx.app.getHttpServer()).post('/v1/licensing/packages/issue')).send({ licenseId: SEED.licenseId });
    const packageId = issue.body.packageId;
    const ack = await auth(request(ctx.app.getHttpServer()).post(`/v1/licensing/packages/${packageId}/ack`)).send({});
    expect(ack.status).toBe(201);
    expect(ack.body.ok).toBe(true);
  });
});
