/**
 * Generates a development epoch keypair and its key document.
 *   bun run keys:dev [--force]
 *
 * Never used in stage or live: there the private key comes from Vault and the
 * key document is mounted alongside it. Both outputs are gitignored.
 */
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { derToPkcs8Pem } from '../apps/backend/src/keys/pem';
import { BLIND_SIGNATURE_SUITE } from '../apps/backend/src/keys/key-document';

const REPO_ROOT = join(import.meta.dir, '..');
export const DEV_KEY_PEM = join(REPO_ROOT, 'config/keys/current.pem');
export const DEV_KEY_DOCUMENT = join(REPO_ROOT, 'config/keys/current.json');

export async function generateDevKeys(): Promise<void> {
  const { privateKey, publicKey } = await RSABSSA.SHA384.generateKey({
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  });

  const now = new Date();
  const document = {
    epoch_id: '0',
    not_before: new Date(now.getTime() - 86_400_000).toISOString(),
    not_after: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
    alg: BLIND_SIGNATURE_SUITE,
    pubkey: Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64'),
  };

  await mkdir(dirname(DEV_KEY_PEM), { recursive: true });
  await writeFile(DEV_KEY_PEM, derToPkcs8Pem(await crypto.subtle.exportKey('pkcs8', privateKey)), {
    mode: 0o600,
  });
  await writeFile(DEV_KEY_DOCUMENT, `${JSON.stringify(document, null, 2)}\n`);
}

export async function ensureDevKeys(force = false): Promise<boolean> {
  if (!force && (await Bun.file(DEV_KEY_PEM).exists()) && (await Bun.file(DEV_KEY_DOCUMENT).exists())) {
    return false;
  }
  await generateDevKeys();
  return true;
}

if (import.meta.main) {
  const written = await ensureDevKeys(Bun.argv.includes('--force'));
  console.log(written ? `wrote ${DEV_KEY_PEM} and ${DEV_KEY_DOCUMENT}` : 'dev keys already present');
}
