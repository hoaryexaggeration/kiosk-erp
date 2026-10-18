import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../../config';
import { DbService } from '../../db/db.service';
import { newId, newOpaqueToken, sha256Hex } from '../../common/ids';
import { hashSecret, verifySecret } from '../../common/password';
import { AppError } from '../../common/errors';
import { AuthContext } from '../../common/auth-context';

const REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(private readonly dbs: DbService) {}

  async login(email: string, password: string, deviceId?: string): Promise<{ context: AuthContext; tokens: TokenPair }> {
    const users = await this.dbs.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email.toLowerCase())
      .where('is_active', '=', true)
      .execute();

    if (users.length === 0) throw AppError.unauthorized('Invalid credentials');
    if (users.length > 1) throw new AppError('AMBIGUOUS_TENANT', 'Email exists in multiple tenants; specify tenant', 409);

    const user = users[0];
    if (!verifySecret(password, user.password_hash)) throw AppError.unauthorized('Invalid credentials');

    const context: AuthContext = {
      userId: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      deviceId,
    };
    const tokens = await this.issueTokens(context);
    return { context, tokens };
  }

  async issueTokens(context: AuthContext, familyId?: string): Promise<TokenPair> {
    const accessToken = await new SignJWT({
      sub: context.userId,
      tenantId: context.tenantId,
      email: context.email,
      deviceId: context.deviceId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(secret);

    const refreshToken = newOpaqueToken(48);
    await this.dbs.db
      .insertInto('refresh_tokens')
      .values({
        user_id: context.userId,
        device_id: context.deviceId ?? null,
        family_id: familyId ?? newId(),
        token_hash: sha256Hex(refreshToken),
        expires_at: new Date(Date.now() + REFRESH_TTL_MS),
      })
      .execute();

    return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
  }

  async verifyAccessToken(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      return {
        userId: String(payload.sub),
        tenantId: String(payload.tenantId),
        email: String(payload.email),
        deviceId: payload.deviceId ? String(payload.deviceId) : undefined,
      };
    } catch {
      throw AppError.unauthorized('Invalid or expired token');
    }
  }

  /** Rotate a refresh token. Reuse of a retired token revokes the whole family (ADR 0002). */
  async refresh(rawToken: string): Promise<TokenPair> {
    const hash = sha256Hex(rawToken);
    const row = await this.dbs.db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hash)
      .executeTakeFirst();

    if (!row) throw AppError.unauthorized('Invalid refresh token');

    if (row.revoked_at || row.expires_at.getTime() < Date.now()) {
      // A retired-but-reused token indicates theft: revoke the family.
      await this.revokeFamily(row.family_id);
      throw AppError.unauthorized('Refresh token expired or revoked');
    }

    const user = await this.dbs.db.selectFrom('users').selectAll().where('id', '=', row.user_id).executeTakeFirst();
    if (!user || !user.is_active) throw AppError.unauthorized('User inactive');

    const context: AuthContext = {
      userId: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      deviceId: row.device_id ?? undefined,
    };
    const tokens = await this.issueTokens(context, row.family_id);

    // Retire the old token and link it to its replacement.
    const newHash = sha256Hex(tokens.refreshToken);
    await this.dbs.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), replaced_by: null })
      .where('id', '=', row.id)
      .execute();
    await this.dbs.db
      .updateTable('refresh_tokens')
      .set({ replaced_by: row.id })
      .where('token_hash', '=', newHash)
      .execute();

    return tokens;
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.dbs.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), reused: true })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async logout(rawToken: string): Promise<void> {
    const hash = sha256Hex(rawToken);
    const row = await this.dbs.db.selectFrom('refresh_tokens').select('family_id').where('token_hash', '=', hash).executeTakeFirst();
    if (row) await this.revokeFamily(row.family_id);
  }

  /** Effective permission codes for a user (RBAC, server-authoritative). */
  async permissionsFor(userId: string): Promise<string[]> {
    const rows = await this.dbs.db
      .selectFrom('user_roles')
      .innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
      .select('role_permissions.permission_code')
      .where('user_roles.user_id', '=', userId)
      .execute();
    return rows.map((r) => r.permission_code);
  }

  hashPassword(password: string): string {
    return hashSecret(password);
  }
}
