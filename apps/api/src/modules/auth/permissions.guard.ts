import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../common/errors';
import { AuthedRequest, PERMISSIONS_KEY } from '../../common/auth-context';
import { AuthService } from './auth.service';

/**
 * Server-side RBAC enforcement (§9, §10). Runs after AuthGuard.
 * A UUID is not proof of access; every required permission is re-checked here.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) throw AppError.unauthorized();
    const granted = await this.auth.permissionsFor(req.auth.userId);
    const missing = required.filter((p) => !granted.includes(p));
    if (missing.length > 0) {
      throw AppError.forbidden(`Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
