// Strict: Buffer.from(_, 'base64') silently skips invalid characters, so a
// malformed blank would otherwise decode to the right length and pass.
export function decodeStrictBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}
