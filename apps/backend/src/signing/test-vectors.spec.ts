import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { derToPkcs8Pem } from '../keys/pem';
import {
  VECTOR_FILE,
  VECTOR_SUITE,
  type TestVectorFile,
} from '../../../../packages/buyer-harness/src/vector-file';
import { base64ToBytes } from '../keys/bytes';
import { scenario } from '../testing/scenario';
import { testIssuerConfig } from '../testing/issuer-harness';
import { SignerPool } from './signer-pool';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const hex = (value: string) => base64ToBytes(Buffer.from(value, 'hex').toString('base64'));

const KEY_ALGORITHM = { name: 'RSA-PSS', hash: 'SHA-384' } as const;

describe('published test vectors', () => {
  scenario('published test vectors cross-verify', async () => {
    const pools: SignerPool[] = [];
    const file = (await Bun.file(join(REPO_ROOT, VECTOR_FILE)).json()) as TestVectorFile;
    expect(file.suite).toBe(VECTOR_SUITE);
    expect(file.vectors.length).toBeGreaterThan(0);

    // The other direction, CIRCL judging ours, runs as a CI job over this same
    // file (see docs/test-vectors.md). Checking CIRCL-produced vectors here is
    // what makes this side a cross-implementation check rather than a
    // self-consistency one, so their presence is part of the assertion.
    const origins = new Set(file.vectors.map((vector) => vector.origin));
    expect(origins).toContain('circl-go');
    expect(origins).toContain('blindrsa-ts');

    const suite = RSABSSA.SHA384.PSS.Randomized();

    for (const vector of file.vectors) {
      // One pool per vector: each carries its own key.
      const pool = new SignerPool(
        testIssuerConfig({ signingWorkers: 1 }),
        {
          epochSigningKeyPem: () =>
            derToPkcs8Pem(Buffer.from(vector.private_key_pkcs8, 'hex').buffer as ArrayBuffer),
        } as never,
      );
      pools.push(pool);
      const publicKey = await crypto.subtle.importKey(
        'spki', hex(vector.public_key_spki), KEY_ALGORITHM, true, ['verify'],
      );

      // Through the pool the service signs with, on a real worker thread, so
      // this pins what the service actually does rather than what the library
      // can do.
      const blindSig = await pool.sign(Buffer.from(vector.blinded_msg, 'hex').toString('base64'));
      expect(Buffer.from(blindSig, 'base64').toString('hex')).toBe(vector.blind_sig);

      expect(await suite.verify(publicKey, hex(vector.sig), hex(vector.prepared_msg))).toBe(true);

      // CIRCL's Finalize takes an opaque State, so only blindrsa-ts vectors
      // carry inv and only they can exercise finalize from recorded bytes.
      if (vector.inv) {
        const finalized = await suite.finalize(
          publicKey, hex(vector.prepared_msg), hex(vector.blind_sig), hex(vector.inv),
        );
        expect(Buffer.from(finalized).toString('hex')).toBe(vector.sig);
      }
    }

    await Promise.all(pools.map((pool) => pool.onModuleDestroy()));
  }, 60_000);
});
