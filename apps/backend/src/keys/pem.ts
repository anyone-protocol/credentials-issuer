import { base64ToBytes } from './bytes';

const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';
const PKCS8_FOOTER = '-----END PRIVATE KEY-----';

/** Returns a fresh Uint8Array: WebCrypto's BufferSource rejects Node's Buffer. */
export function pkcs8PemToDer(pem: string) {
  const body = pem.trim();
  if (!body.startsWith(PKCS8_HEADER) || !body.endsWith(PKCS8_FOOTER)) {
    throw new Error('expected an unencrypted PKCS#8 private key PEM');
  }
  return base64ToBytes(
    body.slice(PKCS8_HEADER.length, body.length - PKCS8_FOOTER.length).replace(/\s+/g, ''),
  );
}

export function derToPkcs8Pem(der: ArrayBuffer): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `${PKCS8_HEADER}\n${lines.join('\n')}\n${PKCS8_FOOTER}\n`;
}

const SPKI_HEADER = '-----BEGIN PUBLIC KEY-----';
const SPKI_FOOTER = '-----END PUBLIC KEY-----';

export function spkiPemToDer(pem: string) {
  const body = pem.trim();
  if (!body.startsWith(SPKI_HEADER) || !body.endsWith(SPKI_FOOTER)) {
    throw new Error('expected a SubjectPublicKeyInfo public key PEM');
  }
  return base64ToBytes(
    body.slice(SPKI_HEADER.length, body.length - SPKI_FOOTER.length).replace(/\s+/g, ''),
  );
}

export function derToSpkiPem(der: ArrayBuffer): string {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? [];
  return `${SPKI_HEADER}\n${lines.join('\n')}\n${SPKI_FOOTER}\n`;
}
