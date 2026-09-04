import { describe, expect, it } from 'bun:test';
import { stubBlindSignature } from './stub-signing';

describe('stubBlindSignature', () => {
  const blank = Buffer.alloc(256, 7).toString('base64');

  it('is deterministic, which is what lets a replay reproduce its response', () => {
    expect(stubBlindSignature('0', blank, 256)).toBe(stubBlindSignature('0', blank, 256));
  });

  it('varies with the blank and with the epoch', () => {
    const other = Buffer.alloc(256, 8).toString('base64');
    expect(stubBlindSignature('0', blank, 256)).not.toBe(stubBlindSignature('0', other, 256));
    expect(stubBlindSignature('0', blank, 256)).not.toBe(stubBlindSignature('1', blank, 256));
  });

  it('produces exactly the configured size', () => {
    for (const size of [64, 256, 512]) {
      expect(Buffer.from(stubBlindSignature('0', blank, size), 'base64').byteLength).toBe(size);
    }
  });
});
