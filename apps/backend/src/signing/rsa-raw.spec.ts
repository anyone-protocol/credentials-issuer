import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { TestVectorFile } from '../../../../packages/buyer-harness/src/vector-file';
import { VECTOR_FILE } from '../../../../packages/buyer-harness/src/vector-file';
import { KNOWN_ANSWER } from './known-answer';
import { selectSigningSuite } from './suite';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const hex = (value: string) => {
  const decoded = Buffer.from(value, 'hex');
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

describe('RSA-RAW fast path', () => {
  it('is selected and reproduces the known answer', async () => {
    const { fastPath, reason } = await selectSigningSuite(true);
    expect({ fastPath, reason }).toEqual({
      fastPath: true,
      reason: `known-answer test ${KNOWN_ANSWER.name} passed`,
    });
  });

  it('agrees with the library pure-JS path on every published vector', async () => {
    const file = (await Bun.file(join(REPO_ROOT, VECTOR_FILE)).json()) as TestVectorFile;
    const { suite: fast } = await selectSigningSuite(true);
    const slow = RSABSSA.SHA384.PSS.Randomized();

    for (const vector of file.vectors) {
      const key = await crypto.subtle.importKey(
        'pkcs8', hex(vector.private_key_pkcs8), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign'],
      );
      const blinded = hex(vector.blinded_msg);

      const viaFast = Buffer.from(await fast.blindSign(key, blinded)).toString('hex');
      const viaSlow = Buffer.from(await slow.blindSign(key, blinded)).toString('hex');

      expect(viaFast).toBe(vector.blind_sig);
      expect(viaFast).toBe(viaSlow);
    }
  }, 30_000);

  // The two paths must fail the same way, or a blank that is merely invalid
  // would surface as a 500 on one path and a typed error on the other.
  it('reports an out-of-range blank the same way as the pure-JS path', async () => {
    const { suite: fast } = await selectSigningSuite(true);
    const slow = RSABSSA.SHA384.PSS.Randomized();
    const key = await crypto.subtle.importKey(
      'pkcs8', hex(KNOWN_ANSWER.privateKeyPkcs8Hex), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign'],
    );
    const outOfRange = new Uint8Array(256).fill(0xff);

    await expect(fast.blindSign(key, outOfRange)).rejects.toThrow(/out of range/i);
    await expect(slow.blindSign(key, outOfRange)).rejects.toThrow(/out of range/i);
  }, 15_000);

  it('falls back to the pure-JS path when disabled', async () => {
    const { fastPath, reason } = await selectSigningSuite(false);
    expect(fastPath).toBe(false);
    expect(reason).toBe('disabled by configuration');
  });

  // The embedded known answer must not drift from the vectors CI cross-verifies
  // against CIRCL, or the boot check would be validating against nothing.
  it('embeds a vector that still matches the published file', async () => {
    const file = (await Bun.file(join(REPO_ROOT, VECTOR_FILE)).json()) as TestVectorFile;
    const published = file.vectors.find((vector) => vector.name === KNOWN_ANSWER.name);

    expect(published?.origin).toBe('circl-go');
    expect(published?.private_key_pkcs8).toBe(KNOWN_ANSWER.privateKeyPkcs8Hex);
    expect(published?.blinded_msg).toBe(KNOWN_ANSWER.blindedMsgHex);
    expect(published?.blind_sig).toBe(KNOWN_ANSWER.blindSigHex);
  });

  it('rejects a fast path that produces the wrong answer', async () => {
    // Simulates a broken polyfill by corrupting what the known answer expects.
    const original = KNOWN_ANSWER.blindSigHex;
    const corrupted = `ff${original.slice(2)}`;
    const patched = { ...KNOWN_ANSWER, blindSigHex: corrupted };

    const { suite } = await selectSigningSuite(true);
    const key = await crypto.subtle.importKey(
      'pkcs8', hex(patched.privateKeyPkcs8Hex), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign'],
    );
    const produced = Buffer.from(
      await suite.blindSign(key, hex(patched.blindedMsgHex)),
    ).toString('hex');

    expect(produced).not.toBe(patched.blindSigHex);
    expect(produced).toBe(original);
  });
});
