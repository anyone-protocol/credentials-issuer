/**
 * Generates development keys: an issuer root key, an epoch keyring with one
 * epoch, and a proxy claim-signing key standing in for TOON's.
 *   bun run keys:dev [--force]
 *
 * Never used in stage or live: there the root key is held by whoever runs
 * rotation, and the keyring is rendered from Vault. All outputs are gitignored.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { derToPkcs8Pem, derToSpkiPem } from '../apps/backend/src/keys/pem';
import { generateRootKey, rotateEpoch } from './rotate-epoch';

const REPO_ROOT = join(import.meta.dir, '..');
const KEYS_DIR = join(REPO_ROOT, 'config/keys');
export const DEV_KEYRING = join(KEYS_DIR, 'keyring.json');
export const DEV_ROOT_KEY = join(KEYS_DIR, 'root.pem');
/** Stands in for the fronting proxy's claim-signing key (M1.4). */
export const DEV_PROXY_KEY_PEM = join(KEYS_DIR, 'proxy.pem');
export const DEV_PROXY_PUBLIC_PEM = join(KEYS_DIR, 'proxy.pub.pem');

const EPOCH_SECONDS = 30 * 86_400;
const GRACE_SECONDS = 86_400;

export async function generateDevKeys(): Promise<void> {
  await mkdir(dirname(DEV_KEYRING), { recursive: true });
  await generateRootKey(DEV_ROOT_KEY);
  await rotateEpoch({
    keyringPath: DEV_KEYRING,
    rootKeyPath: DEV_ROOT_KEY,
    epochSeconds: EPOCH_SECONDS,
    graceSeconds: GRACE_SECONDS,
  });

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
    [DEV_KEYRING, DEV_ROOT_KEY, DEV_PROXY_KEY_PEM, DEV_PROXY_PUBLIC_PEM].map((path) =>
      Bun.file(path).exists(),
    ),
  );
  if (!force && present.every(Boolean)) return false;
  await generateDevKeys();
  return true;
}

if (import.meta.main) {
  const written = await ensureDevKeys(Bun.argv.includes('--force'));
  console.log(written ? `wrote dev keys under ${KEYS_DIR}` : 'dev keys already present');
}
