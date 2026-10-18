import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { EventsService } from '../platform/events.service';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';

export interface EnrollInput {
  deviceId?: string;
  branchId: string;
  name: string;
  platform?: string;
  appVersion?: string;
  publicKeyFingerprint?: string;
  isOfflineAuthoritative?: boolean;
}

@Injectable()
export class DeviceService {
  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
  ) {}

  async enroll(tenantId: string, actorId: string, correlationId: string, input: EnrollInput) {
    const branch = await this.dbs.db
      .selectFrom('branches')
      .select('id')
      .where('id', '=', input.branchId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!branch) throw AppError.notFound('BRANCH_NOT_FOUND', 'Branch not found in tenant');

    const deviceId = input.deviceId ?? newId();

    return this.dbs.transaction(async (trx) => {
      const existing = await trx.selectFrom('devices').selectAll().where('id', '=', deviceId).executeTakeFirst();
      if (existing) {
        if (existing.tenant_id !== tenantId) {
          throw AppError.conflict('TENANT_MISMATCH', 'Device id already bound to another tenant');
        }
        await trx
          .updateTable('devices')
          .set({
            branch_id: input.branchId,
            name: input.name,
            platform: input.platform ?? existing.platform,
            app_version: input.appVersion ?? existing.app_version,
            public_key_fingerprint: input.publicKeyFingerprint ?? existing.public_key_fingerprint,
            is_offline_authoritative: input.isOfflineAuthoritative ?? existing.is_offline_authoritative,
          })
          .where('id', '=', deviceId)
          .execute();
      } else {
        await trx
          .insertInto('devices')
          .values({
            id: deviceId,
            tenant_id: tenantId,
            branch_id: input.branchId,
            name: input.name,
            platform: input.platform ?? 'android',
            app_version: input.appVersion ?? null,
            public_key_fingerprint: input.publicKeyFingerprint ?? null,
            is_offline_authoritative: input.isOfflineAuthoritative ?? false,
          })
          .execute();
      }

      await this.events.audit(trx, {
        tenantId,
        actorId,
        deviceId,
        action: existing ? 'device.re-enrolled' : 'device.enrolled',
        aggregateType: 'Device',
        aggregateId: deviceId,
        after: { branchId: input.branchId, name: input.name },
        correlationId,
      });
      await this.events.serverEvent(trx, {
        tenantId,
        branchId: input.branchId,
        eventType: 'device.enrolled',
        aggregateType: 'Device',
        aggregateId: deviceId,
        payload: { name: input.name, platform: input.platform ?? 'android' },
      });

      return trx.selectFrom('devices').selectAll().where('id', '=', deviceId).executeTakeFirstOrThrow();
    });
  }

  async list(tenantId: string) {
    return this.dbs.db.selectFrom('devices').selectAll().where('tenant_id', '=', tenantId).orderBy('enrolled_at', 'desc').execute();
  }

  async me(tenantId: string, deviceId: string) {
    const device = await this.dbs.db
      .selectFrom('devices')
      .selectAll()
      .where('id', '=', deviceId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!device) throw AppError.notFound('DEVICE_NOT_FOUND', 'Device not enrolled');
    await this.dbs.db.updateTable('devices').set({ last_seen_at: new Date() }).where('id', '=', deviceId).execute();
    return device;
  }

  async revoke(tenantId: string, actorId: string, deviceId: string, correlationId: string) {
    const device = await this.dbs.db
      .selectFrom('devices')
      .selectAll()
      .where('id', '=', deviceId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!device) throw AppError.notFound('DEVICE_NOT_FOUND', 'Device not found');

    return this.dbs.transaction(async (trx) => {
      await trx.updateTable('devices').set({ revoked_at: new Date() }).where('id', '=', deviceId).execute();
      await trx.updateTable('refresh_tokens').set({ revoked_at: new Date() }).where('device_id', '=', deviceId).where('revoked_at', 'is', null).execute();
      await this.events.audit(trx, {
        tenantId,
        actorId,
        deviceId,
        action: 'device.revoked',
        aggregateType: 'Device',
        aggregateId: deviceId,
        correlationId,
      });
      await this.events.serverEvent(trx, {
        tenantId,
        eventType: 'device.revoked',
        aggregateType: 'Device',
        aggregateId: deviceId,
      });
      return { ok: true, deviceId };
    });
  }

  async assertActive(tenantId: string, deviceId: string): Promise<void> {
    const device = await this.dbs.db
      .selectFrom('devices')
      .select(['id', 'revoked_at', 'branch_id'])
      .where('id', '=', deviceId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!device) throw AppError.notFound('DEVICE_NOT_FOUND', 'Device not enrolled');
    if (device.revoked_at) throw AppError.forbidden('Device revoked');
  }
}
