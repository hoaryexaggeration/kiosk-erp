import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { CorrelatedRequest } from '../common/correlation.middleware';

export interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
  deviceId?: string;
}

export const IS_PUBLIC_KEY = 'kiosk:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'kiosk:permissions';
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

export type AuthedRequest = CorrelatedRequest & { auth?: AuthContext };

export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('AuthGuard did not attach a context');
  return req.auth;
});
