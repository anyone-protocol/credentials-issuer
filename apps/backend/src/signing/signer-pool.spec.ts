import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { DEV_KEYRING, ensureDevKeys } from '../../../../scripts/generate-dev-keys';
import { RsaBlinder } from '../../../../packages/buyer-harness/src/blinding';
import { testIssuerConfig } from '../testing/issuer-harness';
import { SignerPool } from './signer-pool';

async function poolWith(overrides: Record<string, unknown> = {}) {
  await ensureDevKeys();
  const keyring = JSON.parse(await readFile(DEV_KEYRING, 'utf8')) as {
    epochs: { epoch_id: string; private_key_pkcs8_pem: string }[];
  };
  const material = keyring.epochs.map((epoch) => ({
    epoch: epoch.epoch_id,
    privateKeyPem: epoch.private_key_pkcs8_pem,
  }));

  return new SignerPool(testIssuerConfig({ signingWorkers: 2, ...overrides }), {
    keyMaterial: () => material,
    onKeysChanged: () => {},
  } as never);
}

/** Blinded against the current epoch's key, and signed under that same epoch:
 *  a blank blinded for one modulus is not valid input for another. */
async function currentEpochBlank(): Promise<{ epoch: string; blank: string }> {
  await ensureDevKeys();
  const keyring = JSON.parse(await readFile(DEV_KEYRING, 'utf8')) as {
    current_epoch: string;
    epochs: { epoch_id: string; pubkey: string }[];
  };
  const current = keyring.epochs.find((e) => e.epoch_id === keyring.current_epoch)!;
  const prepared = await new RsaBlinder().prepare(1, current.pubkey);
  return { epoch: current.epoch_id, blank: prepared.blindedBlanks[0]! };
}

describe('SignerPool inline mode', () => {
  it('signs without starting any worker threads, identically to the pool', async () => {
    const { epoch, blank } = await currentEpochBlank();

    const inline = await poolWith({ signingWorkers: 0 });
    await inline.onModuleInit();
    const viaInline = await inline.sign(epoch, blank);
    // Nothing spawned: SIGNING_WORKERS=0 must mean no worker_threads at all.
    expect((inline as unknown as { slots: unknown[] }).slots).toHaveLength(0);
    await inline.onModuleDestroy();

    const pooled = await poolWith({ signingWorkers: 2 });
    const viaPool = await pooled.sign(epoch, blank);
    await pooled.onModuleDestroy();

    // BlindSign is deterministic, so the two modes are interchangeable.
    expect(viaInline).toBe(viaPool);
  }, 30_000);

  it('still rejects an invalid blank in inline mode', async () => {
    const { epoch } = await currentEpochBlank();
    const inline = await poolWith({ signingWorkers: 0 });
    await inline.onModuleInit();

    await expect(
      inline.sign(epoch, Buffer.alloc(256, 0xff).toString('base64')),
    ).rejects.toThrow(/out of range/i);

    await inline.onModuleDestroy();
  }, 20_000);
});

describe('SignerPool resilience', () => {
  it('keeps serving after a worker dies', async () => {
    const pool = await poolWith();
    const { epoch, blank } = await currentEpochBlank();

    expect(await pool.sign(epoch, blank)).toBeString();

    // Simulate a worker crashing: OOM, an unhandled fault, a kill signal.
    const slots = (pool as unknown as { slots: { worker: { terminate(): Promise<number> } }[] }).slots;
    await slots[0]!.worker.terminate();

    // The pool must recover rather than losing capacity permanently.
    for (let i = 0; i < 4; i += 1) {
      expect(await pool.sign(epoch, blank)).toBeString();
    }
    await pool.onModuleDestroy();
  }, 20_000);

  it('fails a signing task that never comes back rather than hanging forever', async () => {
    const pool = await poolWith({ signingTimeoutMs: 250 });
    const { epoch, blank } = await currentEpochBlank();
    await pool.sign(epoch, blank);

    // A worker that stops answering must not strand the request.
    const slots = (pool as unknown as { slots: { worker: { removeAllListeners(e: string): void } }[] })
      .slots;
    for (const slot of slots) slot.worker.removeAllListeners('message');

    await expect(pool.sign(epoch, blank)).rejects.toThrow(/timed out/i);
    await pool.onModuleDestroy();
  }, 20_000);
});
