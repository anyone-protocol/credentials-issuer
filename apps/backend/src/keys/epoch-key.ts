import { base64ToBytes } from './bytes';
import { pkcs8PemToDer } from './pem';

// RSA-PSS with SHA-384, matching RSABSSA-SHA384-PSS-Randomized (I1).
const KEY_ALGORITHM = { name: 'RSA-PSS', hash: 'SHA-384' } as const;

export function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8PemToDer(pem), KEY_ALGORITHM, true, ['sign']);
}

export function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToBytes(spkiBase64),
    KEY_ALGORITHM,
    true,
    ['verify'],
  );
}

/** SPKI (base64) of the public half of a private key, for comparing against a key document. */
export async function publicSpkiOf(privateKey: CryptoKey): Promise<string> {
  const { n, e } = (await crypto.subtle.exportKey('jwk', privateKey)) as { n?: string; e?: string };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n, e, alg: 'PS384', ext: true, key_ops: ['verify'] },
    KEY_ALGORITHM,
    true,
    ['verify'],
  );
  return Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64');
}
