import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DeviceService } from './device.service';
import { AuthedRequest, AuthContext, CurrentAuth, RequirePermissions } from '../../common/auth-context';
import { AppError } from '../../common/errors';

const EnrollSchema = z.object({
  deviceId: z.string().uuid().optional(),
  branchId: z.string().uuid(),
  name: z.string().min(1).max(120),
  platform: z.enum(['android', 'ios']).optional(),
  appVersion: z.string().max(40).optional(),
  publicKeyFingerprint: z.string().max(200).optional(),
  isOfflineAuthoritative: z.boolean().optional(),
});

const RevokeSchema = z.object({ deviceId: z.string().uuid() });

@Controller('devices')
export class DeviceController {
  constructor(private readonly devices: DeviceService) {}

  @Get('me')
  async me(@CurrentAuth() ctx: AuthContext) {
    if (!ctx.deviceId) throw AppError.validation('Token is not bound to a device');
    return this.devices.me(ctx.tenantId, ctx.deviceId);
  }

  @Get()
  @RequirePermissions('admin.device.manage')
  async list(@CurrentAuth() ctx: AuthContext) {
    return { devices: await this.devices.list(ctx.tenantId) };
  }

  @Post('enroll')
  @RequirePermissions('admin.device.manage')
  async enroll(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = EnrollSchema.parse(body);
    return this.devices.enroll(ctx.tenantId, ctx.userId, req.correlationId, input);
  }

  @Post('revoke')
  @RequirePermissions('admin.device.manage')
  async revoke(@CurrentAuth() ctx: AuthContext, @Req() req: AuthedRequest, @Body() body: unknown) {
    const input = RevokeSchema.parse(body);
    return this.devices.revoke(ctx.tenantId, ctx.userId, input.deviceId, req.correlationId);
  }
}
