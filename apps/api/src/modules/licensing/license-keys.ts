import { readFileSync } from 'node:fs';
import { importPKCS8, importSPKI } from 'jose';
import { config } from '../../config';

/**
 * Loads the ES256 signing keypair for license packages (ADR 0003).
 * The private key is server-only, held in a file for dev or a KMS/HSM in production.
 * It is NEVER bundled in a client app or committed to the repository.
 */
export type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;

interface KeyCache {
  privateKey: SigningKey;
  publicKey: SigningKey;
}

let cache: KeyCache | null = null;

export async function loadSigningKeys(): Promise<KeyCache> {
  if (cache) return cache;
  const privatePem = readFileSync(config.LICENSE_SIGNING_PRIVATE_KEY_PATH, 'utf8');
  const publicPem = readFileSync(config.LICENSE_SIGNING_PUBLIC_KEY_PATH, 'utf8');
  const privateKey = await importPKCS8(privatePem, 'ES256');
  const publicKey = await importSPKI(publicPem, 'ES256');
  cache = { privateKey, publicKey };
  return cache;
}

export function resetSigningKeyCache(): void {
  cache = null;
}
