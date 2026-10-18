/**
 * Generate a development ES256 signing keypair for license packages.
 * NEVER use these keys in production, and never commit the private key.
 * Production uses a KMS/HSM or controlled signing service (ADR 0003, §10).
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { config } from '../../config';

async function main(): Promise<void> {
  if (existsSync(config.LICENSE_SIGNING_PRIVATE_KEY_PATH)) {
    console.log(`Key already exists at ${config.LICENSE_SIGNING_PRIVATE_KEY_PATH}; refusing to overwrite.`);
    return;
  }
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  const spki = await exportSPKI(publicKey);
  mkdirSync(dirname(config.LICENSE_SIGNING_PRIVATE_KEY_PATH), { recursive: true });
  writeFileSync(config.LICENSE_SIGNING_PRIVATE_KEY_PATH, pkcs8, { mode: 0o600 });
  writeFileSync(config.LICENSE_SIGNING_PUBLIC_KEY_PATH, spki, { mode: 0o644 });
  console.log(`Wrote private key: ${config.LICENSE_SIGNING_PRIVATE_KEY_PATH}`);
  console.log(`Wrote public key:  ${config.LICENSE_SIGNING_PUBLIC_KEY_PATH}`);
  console.log(`kid: ${config.LICENSE_SIGNING_KID}`);
  console.log('Embed only the PUBLIC key in the Android/iOS apps.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
