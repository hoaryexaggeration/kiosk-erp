import { Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/database';
import { DbService } from '../../db/db.service';
import { AppError, SyncErrorCode } from '../../common/errors';
import { EventsService } from '../platform/events.service';
import { AuthService } from '../auth/auth.service';
import { SaleService } from '../sales/sale.service';
import { InventoryService } from '../inventory/inventory.service';
import { StockAdjustmentSchema, StockReceiptSchema } from '../inventory/inventory.schema';
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

/** Permission required to apply each synced aggregate (server-side, never the UI). */
const REQUIRED_PERMISSION: Record<string, string> = {
  Sale: 'pos.sale.create',
  StockReceipt: 'inventory.receive',
  StockAdjustment: 'inventory.adjust',
};

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly auth: AuthService,
    private readonly saleService: SaleService,
    private readonly inventoryService: InventoryService,
    private readonly events: EventsService,
  ) {}

  async push(ctx: AuthContext, correlationId: string, commands: CommandEnvelope[]): Promise<{ results: PushResult[] }> {
    // Resolve the actor's permissions once per batch; a device token is not proof of authority.
    const permissions = await this.auth.permissionsFor(ctx.userId);
    const results: PushResult[] = [];
    for (const command of commands) {
      results.push(await this.pushOne(ctx, correlationId, command, permissions));
    }
    return { results };
  }

  private async pushOne(ctx: AuthContext, correlationId: string, command: CommandEnvelope, permissions: string[]): Promise<PushResult> {
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

    const requiredPermission = REQUIRED_PERMISSION[command.aggregateType];
    if (requiredPermission && !permissions.includes(requiredPermission)) {
      return { commandId: command.commandId, status: 'rejected', code: 'FORBIDDEN', message: `Missing permission: ${requiredPermission}` };
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

        // Every conflict code becomes a durable, auditable exception (never a silent failure).
        for (const code of new Set(outcome.conflictCodes ?? [])) {
          await trx
            .insertInto('conflict_cases')
            .values({
              tenant_id: ctx.tenantId,
              command_id: command.commandId,
              aggregate_type: command.aggregateType,
              aggregate_id: command.aggregateId,
              code,
              detail: { result: (outcome.result ?? {}) as never } as never,
            })
            .execute();
        }

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
  ): Promise<{ status: PushResult['status']; result?: Record<string, unknown>; code?: string; message?: string; conflictCodes?: string[] }> {
    const commandCtx = {
      tenantId: ctx.tenantId,
      branchId: command.branchId,
      deviceId: command.deviceId,
      actorId: ctx.userId,
      commandId: command.commandId,
      correlationId,
    };

    if (command.aggregateType === 'Sale') {
      const parsed = SalePayloadSchema.safeParse(command.payload);
      if (!parsed.success) {
        return { status: 'rejected', code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
      }
      const applied = await this.saleService.applySale(trx, commandCtx, parsed.data);
      return { status: applied.status, result: applied.result, conflictCodes: applied.conflictCodes };
    }

    if (command.aggregateType === 'StockReceipt') {
      const parsed = StockReceiptSchema.safeParse(command.payload);
      if (!parsed.success) {
        return { status: 'rejected', code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
      }
      const applied = await this.inventoryService.receiveStock(trx, commandCtx, parsed.data);
      // A refusal must reach the device with its code: "no pack size for this product" is
      // actionable, a bare `rejected` is not (item 4.6, §6 sync state).
      return { status: applied.status, result: applied.result, code: applied.code, message: applied.message, conflictCodes: applied.conflictCodes };
    }

    if (command.aggregateType === 'StockAdjustment') {
      const parsed = StockAdjustmentSchema.safeParse(command.payload);
      if (!parsed.success) {
        return { status: 'rejected', code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
      }
      const applied = await this.inventoryService.adjustStock(trx, commandCtx, parsed.data);
      return { status: applied.status, result: applied.result, code: applied.code, message: applied.message, conflictCodes: applied.conflictCodes };
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
