import { constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt } from 'node:crypto';

/**
 * Supplies WebCrypto's `RSA-RAW` using OpenSSL through node:crypto.
 *
 * blindrsa-ts performs the raw RSA private operation either through `RSA-RAW`
 * (a Cloudflare Workers extension) or, failing that, through pure-JS bignum
 * arithmetic that costs ~280ms per signature. Neither Bun nor Node has
 * `RSA-RAW`, so without this every blind signature takes the slow path.
 *
 * This supplies the missing platform primitive and nothing else: every RFC 9474
 * step still runs inside blindrsa-ts, and the exponentiation is OpenSSL's, not
 * ours. `supportsRSARAW` is a public constructor parameter of the library, not
 * an internal.
 *
 * It is still a global patch, so it is guarded two ways: it declines to install
 * where `RSA-RAW` already works, and the caller must pass a known-answer test
 * before the fast path is used (see known-answer.ts).
 */
const PKCS8 = Symbol('rsa-raw.pkcs8');
const ALGORITHM = 'RSA-RAW';

let installed = false;

interface RawKey {
  readonly [PKCS8]: Buffer;
}

/** Cheap probe: importKey already rejects RSA-RAW where it is unsupported. */
export async function rsaRawIsNative(pkcs8: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    await crypto.subtle.importKey('pkcs8', pkcs8, { name: ALGORITHM, hash: 'SHA-384' }, true, [
      'sign',
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Installs the polyfill unless the platform already provides RSA-RAW. */
export function installRsaRawSupport(): void {
  if (installed) return;
  installed = true;

  const realImportKey = crypto.subtle.importKey.bind(crypto.subtle);
  const realSign = crypto.subtle.sign.bind(crypto.subtle);

  Object.assign(crypto.subtle, {
    importKey(format: string, keyData: ArrayBufferView, algorithm: { name?: string }, ...rest: unknown[]) {
      if (algorithm?.name !== ALGORITHM) {
        return (realImportKey as Function)(format, keyData, algorithm, ...rest);
      }
      const [extractable, usages] = rest as [boolean, string[]];
      return Promise.resolve({
        type: 'private',
        algorithm: { ...algorithm },
        extractable,
        usages,
        [PKCS8]: toBuffer(keyData),
      });
    },

    sign(algorithm: { name?: string } | string, key: RawKey, data: ArrayBufferView) {
      const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
      if (name !== ALGORITHM) return (realSign as Function)(algorithm, key, data);
      return Promise.resolve(rawSign(key[PKCS8], toBuffer(data)));
    },
  });
}

function toBuffer(view: ArrayBufferView | ArrayBuffer): Buffer {
  return ArrayBuffer.isView(view)
    ? Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    : Buffer.from(view);
}

function rawSign(pkcs8: Buffer, message: Buffer): ArrayBuffer {
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

  let signature: Buffer;
  try {
    signature = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, message);
  } catch (error) {
    // RFC 9474 RSASP1 rejects a message that is not less than the modulus, and
    // so does OpenSSL. Rethrown in the library's own wording so both signing
    // paths report an invalid blank identically (see BlindSigner).
    if ((error as { code?: string }).code === 'ERR_OSSL_DATA_TOO_LARGE_FOR_MODULUS') {
      throw new Error('signature representative out of range');
    }
    throw error;
  }

  // RFC 9474 BlindSign steps 3-4: verify the result before returning it, so a
  // faulted exponentiation cannot leak the key. The library performs this on
  // its slow path; Cloudflare's own RSA-RAW path does not, so doing it here
  // keeps the fast path no less defensive than the slow one.
  const roundTrip = publicEncrypt(
    { key: createPublicKey(privateKey), padding: constants.RSA_NO_PADDING },
    signature,
  );
  if (!roundTrip.equals(message)) throw new Error('signing failure');

  return signature.buffer.slice(
    signature.byteOffset,
    signature.byteOffset + signature.byteLength,
  ) as ArrayBuffer;
}
