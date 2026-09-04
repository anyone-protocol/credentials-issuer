import { describe, expect, it } from 'bun:test';
import { decodeStrictBase64 } from './base64';

describe('decodeStrictBase64', () => {
  it('accepts canonical base64', () => {
    expect(decodeStrictBase64(Buffer.alloc(256).toString('base64'))?.byteLength).toBe(256);
  });

  it('rejects input Buffer.from would silently accept', () => {
    // Buffer.from drops the invalid bytes and returns a 256-byte buffer, which
    // is exactly how a malformed blank could sneak past a size check.
    const smuggled = `!!${Buffer.alloc(256).toString('base64')}`;
    expect(Buffer.from(smuggled, 'base64').byteLength).toBe(256);
    expect(decodeStrictBase64(smuggled)).toBeNull();
  });

  it('rejects non-strings, empty input and bad padding', () => {
    for (const value of [undefined, null, 42, '', 'AAAAA']) {
      expect(decodeStrictBase64(value)).toBeNull();
    }
  });
});
