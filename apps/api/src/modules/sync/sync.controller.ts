import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { SyncService } from './sync.service';
import { AuthContext, AuthedRequest, CurrentAuth } from '../../common/auth-context';
import { PushRequestSchema } from './command.schema';

const ResolveSchema = z.object({ action: z.string().min(1), note: z.string().max(500).optional() });

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  async push(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = PushRequestSchema.parse(body);
    return this.sync.push(ctx, req.correlationId, input.commands);
  }

  @Get('pull')
  async pull(@CurrentAuth() ctx: AuthContext, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.sync.pull(ctx, Number(cursor ?? 0) || 0, Number(limit ?? 200) || 200);
  }

  @Get('status')
  async status(@CurrentAuth() ctx: AuthContext) {
    return this.sync.status(ctx);
  }

  @Post('conflicts/:id/resolve')
  async resolve(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    const resolution = ResolveSchema.parse(body);
    return this.sync.resolveConflict(ctx, req.correlationId, id, resolution);
  }
}
