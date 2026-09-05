import { base64ToBytes } from './bytes';
import { canonicalKeyDocument, publishedDocument, type Keyring } from './keyring';
import type { KeyDocument } from './key-document';
import { spkiPemToDer, pkcs8PemToDer } from './pem';

/** The issuer root key. A placeholder for dirauth consensus signing (M1.2). */
export const ROOT_KEY_ALGORITHM = 'Ed25519';

export function importRootSigningKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8PemToDer(pem), { name: ROOT_KEY_ALGORITHM }, true, [
    'sign',
  ]);
}

export function importRootPublicKeyFromPem(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', spkiPemToDer(pem), { name: ROOT_KEY_ALGORITHM }, true, [
    'verify',
  ]);
}

export function importRootPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', base64ToBytes(spkiBase64), { name: ROOT_KEY_ALGORITHM }, true, [
    'verify',
  ]);
}

export async function signKeyDocument(document: KeyDocument, rootKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: ROOT_KEY_ALGORITHM },
    rootKey,
    canonicalKeyDocument(document),
  );
  return Buffer.from(signature).toString('base64url');
}

export function verifyKeyDocument(
  document: KeyDocument,
  rootSig: string,
  rootPublicKey: CryptoKey,
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: ROOT_KEY_ALGORITHM },
    rootPublicKey,
    base64ToBytes(Buffer.from(rootSig, 'base64url').toString('base64')),
    canonicalKeyDocument(document),
  );
}

/**
 * Every epoch's document must verify under the root key, not just the current
 * one: an unsigned or edited entry would let a forged key sign credentials.
 *
 * Shared by the issuer, which refuses a keyring that fails this, and by the
 * rotation tool, which refuses to publish one. Neither should have its own
 * idea of what makes a keyring trustworthy.
 */
export async function verifyKeyringSignatures(keyring: Keyring): Promise<void> {
  const rootPublicKey = await importRootPublicKey(keyring.root_public_key_spki);
  for (const epoch of keyring.epochs) {
    if (!(await verifyKeyDocument(publishedDocument(epoch), epoch.root_sig, rootPublicKey))) {
      throw new Error(`epoch ${epoch.epoch_id} root_sig does not verify under the root key`);
    }
  }
}
