/**
 * Copies into a fresh ArrayBuffer. WebCrypto's BufferSource requires
 * Uint8Array<ArrayBuffer>, which Buffer and Buffer-backed views are not.
 */
export function base64ToBytes(base64: string) {
  const decoded = Buffer.from(base64, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
