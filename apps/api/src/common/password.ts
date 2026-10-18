import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password / PIN hashing with Node's built-in scrypt (vetted primitive, ADR 0002).
 * Format: scrypt$N$r$p$<saltB64>$<hashB64>
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(secret, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = scryptSync(secret, salt, expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
