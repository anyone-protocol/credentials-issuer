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
import { derToPkcs8Pem, derToSpkiPem } from '../apps/backend/src/keys/pem';
import { BLIND_SIGNATURE_SUITE } from '../apps/backend/src/keys/key-document';

const REPO_ROOT = join(import.meta.dir, '..');
export const DEV_KEY_PEM = join(REPO_ROOT, 'config/keys/current.pem');
export const DEV_KEY_DOCUMENT = join(REPO_ROOT, 'config/keys/current.json');
/** Stands in for the fronting proxy's claim-signing key (M1.4). */
export const DEV_PROXY_KEY_PEM = join(REPO_ROOT, 'config/keys/proxy.pem');
export const DEV_PROXY_PUBLIC_PEM = join(REPO_ROOT, 'config/keys/proxy.pub.pem');

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

  const proxy = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  await writeFile(DEV_PROXY_KEY_PEM, derToPkcs8Pem(await crypto.subtle.exportKey('pkcs8', proxy.privateKey)), {
    mode: 0o600,
  });
  await writeFile(DEV_PROXY_PUBLIC_PEM, derToSpkiPem(await crypto.subtle.exportKey('spki', proxy.publicKey)));
}

export async function ensureDevKeys(force = false): Promise<boolean> {
  const present = await Promise.all(
    [DEV_KEY_PEM, DEV_KEY_DOCUMENT, DEV_PROXY_KEY_PEM, DEV_PROXY_PUBLIC_PEM].map((path) =>
      Bun.file(path).exists(),
    ),
  );
  if (!force && present.every(Boolean)) return false;
  await generateDevKeys();
  return true;
}

if (import.meta.main) {
  const written = await ensureDevKeys(Bun.argv.includes('--force'));
  console.log(written ? `wrote epoch and proxy dev keys under ${join(REPO_ROOT, 'config/keys')}` : 'dev keys already present');
}
