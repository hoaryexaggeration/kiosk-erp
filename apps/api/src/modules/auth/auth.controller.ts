import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { CurrentAuth, Public, AuthContext } from '../../common/auth-context';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().uuid().optional(),
});

const RefreshSchema = z.object({ refreshToken: z.string().min(10) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() body: unknown) {
    const input = LoginSchema.parse(body);
    const { context, tokens } = await this.auth.login(input.email, input.password, input.deviceId);
    return {
      user: { id: context.userId, email: context.email, tenantId: context.tenantId },
      ...tokens,
    };
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() body: unknown) {
    const input = RefreshSchema.parse(body);
    return this.auth.refresh(input.refreshToken);
  }

  @Post('logout')
  async logout(@Body() body: unknown) {
    const input = RefreshSchema.parse(body);
    await this.auth.logout(input.refreshToken);
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentAuth() ctx: AuthContext) {
    const permissions = await this.auth.permissionsFor(ctx.userId);
    return { user: ctx, permissions };
  }
}
