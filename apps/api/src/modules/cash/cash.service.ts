import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/database';
import { DbService } from '../../db/db.service';
import { AppError } from '../../common/errors';
import { EventsService } from '../platform/events.service';
import { CashSessionOpenPayload, CashSessionClosePayload } from '../sync/command.schema';

export interface CashCommandContext {
  tenantId: string;
  branchId: string;
  deviceId: string | null;
  actorId: string;
  commandId: string;
  correlationId: string;
}

export interface CashApplyResult {
  status: 'accepted' | 'rejected' | 'conflict';
  result: Record<string, unknown>;
  code?: string;
  message?: string;
  conflictCodes?: string[];
}

/**
 * Drawer sessions (item 5.2, D10). A sale must belong to a drawer that was open when it was
 * taken; the drawer is a physical, offline object, so it opens and closes at the till as sync
 * commands and the server referees when they land. One open session per branch — the drawer is a
 * per-branch object, and a second till must not silently double the day's float.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
  ) {}

  /**
   * Open a drawer. Runs inside the push transaction, so a replayed command is a no-op and a
   * clash with another till on the same branch becomes a named, auditable conflict.
   */
  async open(trx: Kysely<Database>, ctx: CashCommandContext, payload: CashSessionOpenPayload): Promise<CashApplyResult> {
    const existing = await trx.selectFrom('cash_sessions').select('id').where('id', '=', payload.id).executeTakeFirst();
    if (existing) {
      return { status: 'accepted', result: { sessionId: payload.id, note: 'already open' } };
    }

    const openNow = await trx
      .selectFrom('cash_sessions')
      .select(['id', 'opened_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('branch_id', '=', payload.branchId)
      .where('state', '=', 'open')
      .executeTakeFirst();
    if (openNow) {
      // Two drawers on one branch would make the day's cash unreconcilable. Refuse and name the
      // clash rather than silently picking a winner.
      return {
        status: 'conflict',
        result: { sessionId: payload.id, openSessionId: openNow.id },
        code: 'SESSION_ALREADY_OPEN',
        message: `This branch already has an open drawer (opened ${openNow.opened_at.toISOString()}); close it before opening another`,
        conflictCodes: ['SESSION_ALREADY_OPEN'],
      };
    }

    await trx
      .insertInto('cash_sessions')
      .values({
        id: payload.id,
        tenant_id: ctx.tenantId,
        branch_id: payload.branchId,
        device_id: ctx.deviceId,
        opened_by: ctx.actorId,
        state: 'open',
        opening_float_minor: payload.openingFloatMinor,
        opened_at: new Date(payload.openedAt),
      })
      .execute();

    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: payload.branchId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'cash.session.opened',
      aggregateType: 'CashSession',
      aggregateId: payload.id,
      reason: `float ${payload.openingFloatMinor}`,
      correlationId: ctx.correlationId,
    });
    await this.events.serverEvent(trx, {
      tenantId: ctx.tenantId,
      branchId: payload.branchId,
      eventType: 'cash.session.opened',
      aggregateType: 'CashSession',
      aggregateId: payload.id,
      payload: { openingFloatMinor: payload.openingFloatMinor },
    });

    return { status: 'accepted', result: { sessionId: payload.id, state: 'open' } };
  }

  /**
   * Close a drawer with its counted cash. The expected figure is derived SERVER-side from the
   * float plus the cash the drawer actually took (sales tendered in cash): a count is a reading,
   * and a reading never decides what the books say (§1.6 rule 3).
   */
  async close(trx: Kysely<Database>, ctx: CashCommandContext, payload: CashSessionClosePayload): Promise<CashApplyResult> {
    const session = await trx
      .selectFrom('cash_sessions')
      .selectAll()
      .where('id', '=', payload.id)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!session) {
      return { status: 'rejected', result: {}, code: 'SESSION_NOT_FOUND', message: 'No such drawer session' };
    }
    if (session.state === 'closed') {
      return { status: 'accepted', result: { sessionId: payload.id, state: 'closed', note: 'already closed' } };
    }

    // Drawer cash = float + cash tendered on this session's sales. Only cash tenders count:
    // money tendered by card or M-PESA never entered the drawer. Paid-outs, safe drops and
    // refunds join this derivation when Phase 6 lands; today the shape is already honest.
    const cashRow = await trx
      .selectFrom('sales')
      .innerJoin('tenders', 'tenders.sale_id', 'sales.id')
      .select(({ fn }) => fn.sum<number>('tenders.amount_minor').as('tendered'))
      .where('sales.cash_session_id', '=', session.id)
      .where('sales.tenant_id', '=', ctx.tenantId)
      .where('tenders.method', '=', 'cash')
      .executeTakeFirst();
    const expectedMinor = session.opening_float_minor + Number(cashRow?.tendered ?? 0);
    const varianceMinor = payload.countedMinor - expectedMinor;

    await trx
      .updateTable('cash_sessions')
      .set({
        state: 'closed',
        closed_at: new Date(payload.closedAt),
        counted_minor: payload.countedMinor,
        expected_minor: expectedMinor,
        variance_minor: varianceMinor,
      })
      .where('id', '=', session.id)
      .execute();

    await this.events.audit(trx, {
      tenantId: ctx.tenantId,
      branchId: session.branch_id,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      action: 'cash.session.closed',
      aggregateType: 'CashSession',
      aggregateId: session.id,
      reason: `counted ${payload.countedMinor}, expected ${expectedMinor}, variance ${varianceMinor}`,
      correlationId: ctx.correlationId,
    });
    await this.events.serverEvent(trx, {
      tenantId: ctx.tenantId,
      branchId: session.branch_id,
      eventType: 'cash.session.closed',
      aggregateType: 'CashSession',
      aggregateId: session.id,
      payload: { countedMinor: payload.countedMinor, expectedMinor, varianceMinor },
    });

    return {
      status: 'accepted',
      result: { sessionId: session.id, state: 'closed', countedMinor: payload.countedMinor, expectedMinor, varianceMinor },
    };
  }

  /** The drawer this branch is trading from right now, or null (item 5.2). */
  async current(tenantId: string, branchId: string) {
    const row = await this.dbs.db
      .selectFrom('cash_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('branch_id', '=', branchId)
      .where('state', '=', 'open')
      .orderBy('opened_at', 'desc')
      .executeTakeFirst();
    return row ?? null;
  }

  async byId(tenantId: string, id: string) {
    const row = await this.dbs.db
      .selectFrom('cash_sessions')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!row) throw AppError.notFound('SESSION_NOT_FOUND', 'No such drawer session');
    return row;
  }
}
