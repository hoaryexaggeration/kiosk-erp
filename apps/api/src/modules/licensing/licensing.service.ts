import { Injectable, Logger } from '@nestjs/common';
import { CompactSign, compactVerify, exportJWK } from 'jose';
import { DbService } from '../../db/db.service';
import { EventsService } from '../platform/events.service';
import { AppError } from '../../common/errors';
import { newId, newOpaqueToken, sha256Hex } from '../../common/ids';
import { loadSigningKeys } from './license-keys';
import { config } from '../../config';

export interface LicensePackagePayload {
  formatVersion: 1;
  licenseId: string;
  tenantId: string;
  planId: string;
  editionId: string;
  entitlementIds: string[];
  perpetualCore: boolean;
  maintenanceExpiresAt: string | null;
  connectedServicesExpiresAt: string | null;
  deviceQuota: number;
  branchQuota: number;
  minAppBuild: number;
  packageSerial: string;
  revision: number;
  requestNonce: string | null;
  issuedAt: string;
  deviceKeyFingerprints: string[];
  kid: string;
}

@Injectable()
export class LicensingService {
  private readonly logger = new Logger(LicensingService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
  ) {}

  async status(tenantId: string) {
    const license = await this.dbs.db.selectFrom('licenses').selectAll().where('tenant_id', '=', tenantId).orderBy('created_at', 'desc').executeTakeFirst();
    if (!license) {
      return { license: null, entitlements: [], perpetualCoreActive: false };
    }
    const [plan, entitlements] = await Promise.all([
      this.dbs.db.selectFrom('license_plans').selectAll().where('id', '=', license.plan_id).executeTakeFirst(),
      this.dbs.db.selectFrom('license_entitlements').select('entitlement_id').where('license_id', '=', license.id).execute(),
    ]);
    const now = Date.now();
    return {
      license: {
        id: license.id,
        planId: license.plan_id,
        state: license.state,
        revision: license.revision,
        packageSerial: license.package_serial,
        maintenanceExpiresAt: license.maintenance_expires_at,
        connectedServicesExpiresAt: license.connected_services_expires_at,
        deviceKeyFingerprints: license.device_key_fingerprints,
      },
      plan: plan ?? null,
      entitlements: entitlements.map((e) => e.entitlement_id),
      perpetualCoreActive: Boolean(plan?.perpetual_core),
      maintenanceActive: Boolean(license.maintenance_expires_at && license.maintenance_expires_at.getTime() > now),
      connectedServicesActive: Boolean(license.connected_services_expires_at && license.connected_services_expires_at.getTime() > now),
    };
  }

  async entitlements(tenantId: string) {
    const s = await this.status(tenantId);
    return { entitlements: s.entitlements, planId: s.license?.planId ?? null };
  }

  /** Export a renewal/activation request (QR/file). Contains no customer or sales data (§13.4). */
  async createRequest(
    tenantId: string,
    actorId: string,
    correlationId: string,
    input: { requestedPlanId?: string; requestedTermDays?: number; publicKeyFingerprint?: string },
  ) {
    const license = await this.dbs.db.selectFrom('licenses').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
    const id = newId();
    const nonce = newOpaqueToken(24);
    return this.dbs.transaction(async (trx) => {
      await trx
        .insertInto('license_requests')
        .values({
          id,
          tenant_id: tenantId,
          license_id: license?.id ?? null,
          nonce,
          requested_plan_id: input.requestedPlanId ?? null,
          requested_term_days: input.requestedTermDays ?? null,
          public_key_fingerprint: input.publicKeyFingerprint ?? null,
          state: 'exported',
        })
        .execute();
      await trx.insertInto('license_audit_events').values({ tenant_id: tenantId, action: 'license.request.exported', detail: { requestId: id, nonce } as never, actor: actorId }).execute();
      await this.events.audit(trx, { tenantId, actorId, action: 'license.request.exported', aggregateType: 'LicenseRequest', aggregateId: id, correlationId });
      return {
        requestId: id,
        nonce,
        tenantId,
        licenseId: license?.id ?? null,
        currentSerial: license?.package_serial ?? null,
        currentRevision: license?.revision ?? 0,
        requestedPlanId: input.requestedPlanId ?? null,
        requestedTermDays: input.requestedTermDays ?? null,
        publicKeyFingerprint: input.publicKeyFingerprint ?? null,
        appSchemaVersion: 1,
        createdAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Issue a signed JWS package. In production this is behind an admin/issuing service with
   * audited access; the private key never leaves the signer.
   */
  async issuePackage(
    tenantId: string,
    actorId: string,
    correlationId: string,
    input: { licenseId: string; requestId?: string; planId?: string; termDays?: number },
  ) {
    const license = await this.dbs.db.selectFrom('licenses').selectAll().where('id', '=', input.licenseId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!license) throw AppError.notFound('LICENSE_NOT_FOUND', 'License not found');

    const plan = await this.dbs.db.selectFrom('license_plans').selectAll().where('id', '=', input.planId ?? license.plan_id).executeTakeFirst();
    if (!plan) throw AppError.notFound('PLAN_NOT_FOUND', 'License plan not found');

    const request = input.requestId
      ? await this.dbs.db.selectFrom('license_requests').selectAll().where('id', '=', input.requestId).where('tenant_id', '=', tenantId).executeTakeFirst()
      : undefined;

    const revision = (license.revision ?? 0) + 1;
    const serial = `LIC-${sha256Hex(`${license.id}:${revision}`).slice(0, 12).toUpperCase()}`;
    const now = new Date();
    const termDays = input.termDays ?? plan.maintenance_days ?? 0;
    const maintenanceExpiresAt = termDays > 0 ? new Date(now.getTime() + termDays * 86400000).toISOString() : null;
    const connectedExpiresAt = plan.connected_services && termDays > 0 ? new Date(now.getTime() + termDays * 86400000).toISOString() : null;

    const payload: LicensePackagePayload = {
      formatVersion: 1,
      licenseId: license.id,
      tenantId,
      planId: plan.id,
      editionId: plan.edition,
      entitlementIds: plan.entitlement_ids,
      perpetualCore: plan.perpetual_core,
      maintenanceExpiresAt,
      connectedServicesExpiresAt: connectedExpiresAt,
      deviceQuota: plan.device_quota,
      branchQuota: plan.branch_quota,
      minAppBuild: 1,
      packageSerial: serial,
      revision,
      requestNonce: request?.nonce ?? null,
      issuedAt: now.toISOString(),
      deviceKeyFingerprints: license.device_key_fingerprints ?? [],
      kid: config.LICENSE_SIGNING_KID,
    };

    const { privateKey, publicKey } = await loadSigningKeys();
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'ES256', kid: config.LICENSE_SIGNING_KID, typ: 'kiosk-license+jws' })
      .sign(privateKey);

    // Register the public key (idempotent) so clients/ops can pin it.
    const jwk = await exportJWK(publicKey);
    await this.dbs.db
      .insertInto('signing_keys')
      .values({ kid: config.LICENSE_SIGNING_KID, public_jwk: jwk as never, algorithm: 'ES256', active: true })
      .onConflict((oc) => oc.column('kid').doUpdateSet({ public_jwk: jwk as never, active: true }))
      .execute();

    const packageId = newId();
    return this.dbs.transaction(async (trx) => {
      await trx
        .insertInto('license_packages')
        .values({ id: packageId, tenant_id: tenantId, license_id: license.id, request_id: request?.id ?? null, serial, revision, kid: config.LICENSE_SIGNING_KID, payload: payload as never, jws })
        .execute();
      await trx
        .updateTable('licenses')
        .set({
          plan_id: plan.id,
          revision,
          package_serial: serial,
          maintenance_expires_at: maintenanceExpiresAt ? new Date(maintenanceExpiresAt) : null,
          connected_services_expires_at: connectedExpiresAt ? new Date(connectedExpiresAt) : null,
        })
        .where('id', '=', license.id)
        .execute();
      // Keep the entitlement projection in sync.
      await trx.deleteFrom('license_entitlements').where('license_id', '=', license.id).execute();
      for (const entitlement of plan.entitlement_ids) {
        await trx.insertInto('license_entitlements').values({ license_id: license.id, entitlement_id: entitlement }).execute();
      }
      if (request) {
        await trx.updateTable('license_requests').set({ state: 'package_issued' }).where('id', '=', request.id).execute();
      }
      await trx.insertInto('license_audit_events').values({ tenant_id: tenantId, action: 'license.package.issued', detail: { packageId, serial, revision, kid: config.LICENSE_SIGNING_KID } as never, actor: actorId }).execute();
      await this.events.audit(trx, { tenantId, actorId, action: 'license.package.issued', aggregateType: 'LicensePackage', aggregateId: packageId, after: { serial, revision }, correlationId });
      await this.events.serverEvent(trx, { tenantId, eventType: 'license.package.issued', aggregateType: 'LicensePackage', aggregateId: packageId, payload: { serial, revision } });

      return { packageId, serial, revision, kid: config.LICENSE_SIGNING_KID, jws, payload };
    });
  }

  /** Verify a JWS package server-side (also used on acknowledgement). */
  async verifyPackage(jws: string): Promise<LicensePackagePayload> {
    const { publicKey } = await loadSigningKeys();
    try {
      const { payload, protectedHeader } = await compactVerify(jws, publicKey, { algorithms: ['ES256'] });
      if (protectedHeader.kid !== config.LICENSE_SIGNING_KID) {
        throw new Error(`Unexpected kid ${protectedHeader.kid}`);
      }
      return JSON.parse(new TextDecoder().decode(payload)) as LicensePackagePayload;
    } catch (err) {
      throw AppError.validation(`Invalid license package: ${(err as Error).message}`);
    }
  }

  async ackPackage(tenantId: string, actorId: string, correlationId: string, packageId: string) {
    const pkg = await this.dbs.db.selectFrom('license_packages').selectAll().where('id', '=', packageId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!pkg) throw AppError.notFound('PACKAGE_NOT_FOUND', 'License package not found');
    // Re-verify before acknowledging; never trust a stored boolean.
    const payload = await this.verifyPackage(pkg.jws);
    return this.dbs.transaction(async (trx) => {
      await trx.updateTable('license_packages').set({ acked_at: new Date() }).where('id', '=', packageId).execute();
      await trx.insertInto('license_audit_events').values({ tenant_id: tenantId, action: 'license.package.acknowledged', detail: { packageId, serial: payload.packageSerial } as never, actor: actorId }).execute();
      await this.events.audit(trx, { tenantId, actorId, action: 'license.package.acknowledged', aggregateType: 'LicensePackage', aggregateId: packageId, correlationId });
      return { ok: true, packageId, serial: payload.packageSerial };
    });
  }

  /** Single tested entitlement policy hook (used by admin/connected-service gates only). */
  async hasEntitlement(tenantId: string, entitlementId: string): Promise<boolean> {
    const row = await this.dbs.db
      .selectFrom('license_entitlements')
      .innerJoin('licenses', 'licenses.id', 'license_entitlements.license_id')
      .select('license_entitlements.entitlement_id')
      .where('licenses.tenant_id', '=', tenantId)
      .where('license_entitlements.entitlement_id', '=', entitlementId)
      .executeTakeFirst();
    return Boolean(row);
  }
}
