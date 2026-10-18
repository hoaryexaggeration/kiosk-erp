import { randomUUID, randomBytes } from 'node:crypto';

/** Stable, client-or-server generated business id (ADR 0006). */
export function newId(): string {
  return randomUUID();
}

/** Opaque, high-entropy token (refresh tokens, license nonces). */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex digest — used to store refresh tokens without keeping the raw value. */
export function sha256Hex(input: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}
