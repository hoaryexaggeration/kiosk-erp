import { Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/database';
import { DbService } from '../../db/db.service';
import { AppError, SyncErrorCode } from '../../common/errors';
import { EventsService } from '../platform/events.service';
import { SaleService } from '../sales/sale.service';
import { CommandEnvelope, SalePayloadSchema } from './command.schema';
import { AuthContext } from '../../common/auth-context';

export interface PushResult {
  commandId: string;
  status: 'accepted' | 'duplicate' | 'retryable' | 'rejected' | 'conflict' | 'review_required';
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
  conflictId?: string;
}

const CURRENT_SCHEMA_VERSION = 1;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly saleService: SaleService,
    private readonly events: EventsService,
  ) {}

  async push(ctx: AuthContext, correlationId: string, commands: CommandEnvelope[]): Promise<{ results: PushResult[] }> {
    const results: PushResult[] = [];
    for (const command of commands) {
      results.push(await this.pushOne(ctx, correlationId, command));
    }
    return { results };
  }

  private async pushOne(ctx: AuthContext, correlationId: string, command: CommandEnvelope): Promise<PushResult> {
    // Session scope is authoritative; the client cannot choose tenant/device identities.
    if (command.tenantId && command.tenantId !== ctx.tenantId) {
      return { commandId: command.commandId, status: 'rejected', code: SyncErrorCode.TENANT_MISMATCH, message: 'Command tenant does not match session' };
    }
    if (ctx.deviceId && command.deviceId !== ctx.deviceId) {
      return { commandId: command.commandId, status: 'rejected', code: 'DEVICE_MISMATCH', message: 'Command device does not match authenticated device' };
    }
    if (command.schemaVersion > CURRENT_SCHEMA_VERSION) {
      return { commandId: command.commandId, status: 'rejected', code: SyncErrorCode.SCHEMA_UNSUPPORTED, message: `Server supports schemaVersion <= ${CURRENT_SCHEMA_VERSION}` };
    }

    try {
      return await this.dbs.transaction(async (trx) => {
        const prior = await trx
          .selectFrom('processed_commands')
          .select(['status', 'result'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('command_id', '=', command.commandId)
          .executeTakeFirst();
        if (prior) {
          return { commandId: command.commandId, status: 'duplicate', result: prior.result as Record<string, unknown> };
        }

        const outcome = await this.dispatch(trx, ctx, correlationId, command);

        await trx
          .insertInto('processed_commands')
          .values({
            tenant_id: ctx.tenantId,
            command_id: command.commandId,
            aggregate_type: command.aggregateType,
            aggregate_id: command.aggregateId,
            status: outcome.status,
            result: (outcome.result ?? {}) as never,
          })
          .execute();

        return {
          commandId: command.commandId,
          status: outcome.status,
          result: outcome.result,
          ...(outcome.code ? { code: outcome.code } : {}),
          ...(outcome.message ? { message: outcome.message } : {}),
        };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Concurrent duplicate: return the stored result.
        const prior = await this.dbs.db
          .selectFrom('processed_commands')
          .select(['result'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('command_id', '=', command.commandId)
          .executeTakeFirst();
        if (prior) return { commandId: command.commandId, status: 'duplicate', result: prior.result as Record<string, unknown> };
      }
      if (err instanceof AppError) {
        return { commandId: command.commandId, status: err.extra.retryable ? 'retryable' : 'rejected', code: err.code, message: err.message };
      }
      this.logger.error(`push failed for ${command.commandId}: ${(err as Error).stack}`);
      return { commandId: command.commandId, status: 'retryable', code: 'RETRYABLE', message: 'Temporary failure; retry with the same commandId' };
    }
  }

  private async dispatch(
    trx: Kysely<Database>,
    ctx: AuthContext,
    correlationId: string,
    command: CommandEnvelope,
  ): Promise<{ status: PushResult['status']; result?: Record<string, unknown>; code?: string; message?: string }> {
    if (command.aggregateType === 'Sale') {
      const parsed = SalePayloadSchema.safeParse(command.payload);
      if (!parsed.success) {
        return { status: 'rejected', code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
      }
      const applied = await this.saleService.applySale(
        trx,
        {
          tenantId: ctx.tenantId,
          branchId: command.branchId,
          deviceId: command.deviceId,
          actorId: ctx.userId,
          commandId: command.commandId,
          correlationId,
        },
        parsed.data,
      );
      return { status: applied.status, result: applied.result };
    }
    return { status: 'rejected', code: 'UNSUPPORTED_AGGREGATE', message: `Unsupported aggregateType: ${command.aggregateType}` };
  }

  async pull(ctx: AuthContext, cursor: number, limit: number): Promise<{ events: unknown[]; cursor: number; hasMore: boolean }> {
    const capped = Math.min(Math.max(limit, 1), 500);
    const rows = await this.dbs.db
      .selectFrom('server_events')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('seq', '>', cursor)
      .orderBy('seq', 'asc')
      .limit(capped + 1)
      .execute();
    const hasMore = rows.length > capped;
    const page = hasMore ? rows.slice(0, capped) : rows;
    const newCursor = page.length > 0 ? page[page.length - 1].seq : cursor;
    return {
      events: page.map((r) => ({
        seq: r.seq,
        eventType: r.event_type,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        branchId: r.branch_id,
        payload: r.payload,
        createdAt: r.created_at,
      })),
      cursor: newCursor,
      hasMore,
    };
  }

  async status(ctx: AuthContext) {
    const head = await this.dbs.db
      .selectFrom('server_events')
      .select(({ fn }) => fn.max<number>('seq').as('max'))
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    const conflicts = await this.dbs.db
      .selectFrom('conflict_cases')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', ctx.tenantId)
      .where('state', '=', 'open')
      .executeTakeFirst();
    const device = ctx.deviceId
      ? await this.dbs.db.selectFrom('devices').selectAll().where('id', '=', ctx.deviceId).executeTakeFirst()
      : null;
    return {
      serverTime: new Date().toISOString(),
      serverCursor: Number(head?.max ?? 0),
      openConflicts: Number(conflicts?.count ?? 0),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      device: device ?? null,
    };
  }

  async resolveConflict(ctx: AuthContext, correlationId: string, conflictId: string, resolution: unknown) {
    const conflict = await this.dbs.db
      .selectFrom('conflict_cases')
      .selectAll()
      .where('id', '=', conflictId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!conflict) throw AppError.notFound('CONFLICT_NOT_FOUND', 'Conflict case not found');
    if (conflict.state === 'resolved') return { ok: true, alreadyResolved: true };

    return this.dbs.transaction(async (trx) => {
      await trx
        .updateTable('conflict_cases')
        .set({ state: 'resolved', resolved_by: ctx.userId, resolution: resolution as never, resolved_at: new Date() })
        .where('id', '=', conflictId)
        .execute();
      await this.events.audit(trx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        deviceId: ctx.deviceId,
        action: 'sync.conflict.resolved',
        aggregateType: 'ConflictCase',
        aggregateId: conflictId,
        reason: JSON.stringify(resolution),
        correlationId,
      });
      await this.events.serverEvent(trx, {
        tenantId: ctx.tenantId,
        eventType: 'sync.conflict.resolved',
        aggregateType: 'ConflictCase',
        aggregateId: conflictId,
        payload: { resolution },
      });
      return { ok: true, conflictId };
    });
  }
}
