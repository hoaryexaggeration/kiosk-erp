import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { LicensingService } from './licensing.service';
import { AuthContext, AuthedRequest, CurrentAuth, RequirePermissions } from '../../common/auth-context';

const RequestSchema = z.object({
  requestedPlanId: z.string().max(64).optional(),
  requestedTermDays: z.number().int().positive().max(3650).optional(),
  publicKeyFingerprint: z.string().max(200).optional(),
});

const IssueSchema = z.object({
  licenseId: z.string().uuid(),
  requestId: z.string().uuid().optional(),
  planId: z.string().max(64).optional(),
  termDays: z.number().int().positive().max(3650).optional(),
});

const AckSchema = z.object({ packageId: z.string().uuid() });

@Controller('licensing')
export class LicensingController {
  constructor(private readonly licensing: LicensingService) {}

  @Get('status')
  async status(@CurrentAuth() ctx: AuthContext) {
    return this.licensing.status(ctx.tenantId);
  }

  @Get('entitlements')
  async entitlements(@CurrentAuth() ctx: AuthContext) {
    return this.licensing.entitlements(ctx.tenantId);
  }

  @Post('requests')
  @RequirePermissions('license.manage')
  async createRequest(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = RequestSchema.parse(body);
    return this.licensing.createRequest(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Post('packages/issue')
  @RequirePermissions('license.manage')
  async issue(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = IssueSchema.parse(body);
    return this.licensing.issuePackage(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Post('packages/:id/ack')
  @RequirePermissions('license.manage')
  async ack(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Param('id') id: string) {
    return this.licensing.ackPackage(ctx.tenantId, ctx.userId, req.correlationId, id);
  }

  @Post('packages/verify')
  async verify(@Body() body: unknown) {
    const input = z.object({ jws: z.string().min(20) }).parse(body);
    return this.licensing.verifyPackage(input.jws);
  }
}
