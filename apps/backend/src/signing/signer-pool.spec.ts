import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { DEV_KEY_PEM, ensureDevKeys } from '../../../../scripts/generate-dev-keys';
import { RsaBlinder } from '../../../../packages/buyer-harness/src/blinding';
import { testIssuerConfig } from '../testing/issuer-harness';
import { SignerPool } from './signer-pool';

async function poolWith(overrides: Record<string, unknown> = {}) {
  await ensureDevKeys();
  const privateKeyPem = await readFile(DEV_KEY_PEM, 'utf8');
  const pool = new SignerPool(
    testIssuerConfig({ signingWorkers: 2, ...overrides }),
    { epochSigningKeyPem: () => privateKeyPem } as never,
  );
  return pool;
}

async function aBlank(): Promise<string> {
  const doc = JSON.parse(await readFile('config/keys/current.json', 'utf8')) as { pubkey: string };
  const prepared = await new RsaBlinder().prepare(1, doc.pubkey);
  return prepared.blindedBlanks[0]!;
}

describe('SignerPool resilience', () => {
  it('keeps serving after a worker dies', async () => {
    const pool = await poolWith();
    const blank = await aBlank();

    expect(await pool.sign(blank)).toBeString();

    // Simulate a worker crashing: OOM, an unhandled fault, a kill signal.
    const slots = (pool as unknown as { slots: { worker: { terminate(): Promise<number> } }[] }).slots;
    await slots[0]!.worker.terminate();

    // The pool must recover rather than losing capacity permanently.
    for (let i = 0; i < 4; i += 1) {
      expect(await pool.sign(blank)).toBeString();
    }
    await pool.onModuleDestroy();
  }, 20_000);

  it('fails a signing task that never comes back rather than hanging forever', async () => {
    const pool = await poolWith({ signingTimeoutMs: 250 });
    const blank = await aBlank();
    await pool.sign(blank);

    // A worker that stops answering must not strand the request.
    const slots = (pool as unknown as { slots: { worker: { removeAllListeners(e: string): void } }[] })
      .slots;
    for (const slot of slots) slot.worker.removeAllListeners('message');

    await expect(pool.sign(blank)).rejects.toThrow(/timed out/i);
    await pool.onModuleDestroy();
  }, 20_000);
});
