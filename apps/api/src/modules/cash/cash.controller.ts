import { Controller, Get, Param, Query } from '@nestjs/common';
import { AuthContext, CurrentAuth } from '../../common/auth-context';
import { CashService } from './cash.service';

/**
 * Read-only drawer endpoints (item 5.2). Opening and closing travel as sync commands — the till
 * must be able to do both offline — so these routes exist to SEE the drawer: the till's gate at
 * boot, and any back-office view of today's sessions.
 */
@Controller('cash/sessions')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Get('current')
  async current(@CurrentAuth() ctx: AuthContext, @Query('branchId') branchId?: string) {
    const branch = branchId ?? '';
    if (!branch) return { session: null };
    const row = await this.cash.current(ctx.tenantId, branch);
    return { session: row ? toSessionDto(row) : null };
  }

  @Get(':id')
  async byId(@CurrentAuth() ctx: AuthContext, @Param('id') id: string) {
    const row = await this.cash.byId(ctx.tenantId, id);
    return { session: toSessionDto(row) };
  }
}

/** Row → wire shape: camelCase, ISO timestamps, money in minor units (§14). */
function toSessionDto(row: {
  id: string;
  branch_id: string;
  device_id: string | null;
  opened_by: string | null;
  state: string;
  opening_float_minor: number;
  counted_minor: number | null;
  expected_minor: number | null;
  variance_minor: number | null;
  opened_at: Date;
  closed_at: Date | null;
}) {
  return {
    id: row.id,
    branchId: row.branch_id,
    deviceId: row.device_id,
    openedBy: row.opened_by,
    state: row.state,
    openingFloatMinor: row.opening_float_minor,
    countedMinor: row.counted_minor,
    expectedMinor: row.expected_minor,
    varianceMinor: row.variance_minor,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  };
}
