import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/database';

export interface AuditInput {
  tenantId: string;
  branchId?: string | null;
  actorId?: string | null;
  deviceId?: string | null;
  action: string;
  aggregateType?: string;
  aggregateId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  correlationId?: string | null;
}

export interface ServerEventInput {
  tenantId: string;
  branchId?: string | null;
  eventType: string;
  aggregateType?: string;
  aggregateId?: string | null;
  payload?: unknown;
}

/**
 * Writes the three append-only platform records that must commit in the SAME transaction as
 * the business effect (§1.6 rule 2, §9):
 *  - audit_events   (who did what, why)
 *  - server_events  (orderable sync deltas for clients, cursor source)
 *  - outbox_events  (transactional outbox for realtime/integration fan-out)
 * Accepts a Kysely instance so it can join the caller's transaction (`trx`) or the root `db`.
 */
@Injectable()
export class EventsService {
  async audit(trx: Kysely<Database>, input: AuditInput): Promise<void> {
    await trx
      .insertInto('audit_events')
      .values({
        tenant_id: input.tenantId,
        branch_id: input.branchId ?? null,
        actor_id: input.actorId ?? null,
        device_id: input.deviceId ?? null,
        action: input.action,
        aggregate_type: input.aggregateType ?? null,
        aggregate_id: input.aggregateId ?? null,
        reason: input.reason ?? null,
        before_summary: (input.before ?? null) as never,
        after_summary: (input.after ?? null) as never,
        correlation_id: input.correlationId ?? null,
      })
      .execute();
  }

  async serverEvent(trx: Kysely<Database>, input: ServerEventInput): Promise<number> {
    const row = await trx
      .insertInto('server_events')
      .values({
        tenant_id: input.tenantId,
        branch_id: input.branchId ?? null,
        event_type: input.eventType,
        aggregate_type: input.aggregateType ?? null,
        aggregate_id: input.aggregateId ?? null,
        payload: (input.payload ?? {}) as never,
      })
      .returning('seq')
      .executeTakeFirstOrThrow();
    return row.seq;
  }

  async outbox(trx: Kysely<Database>, tenantId: string, eventType: string, payload: unknown): Promise<void> {
    await trx
      .insertInto('outbox_events')
      .values({ tenant_id: tenantId, event_type: eventType, payload: payload as never })
      .execute();
  }
}
