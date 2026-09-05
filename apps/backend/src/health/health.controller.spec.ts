import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRootKey, rotateEpoch } from '../../../../scripts/rotate-epoch';
import { RsaBlinder } from '../../../../packages/buyer-harness/src/blinding';
import {
  claimHeader,
  errorCode,
  startIssuer,
  uniquePaymentRef,
  type IssuerHarness,
} from '../testing/issuer-harness';

const started: IssuerHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const EPOCH_SECONDS = 30 * 86_400;

/** A keyring rotated at `now`, so a past `now` yields an epoch already expired. */
async function keyringRotatedAt(now: Date): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issuer-health-'));
  directories.push(dir);
  const path = join(dir, 'keyring.json');
  const rootKey = join(dir, 'root.pem');
  await generateRootKey(rootKey);
  await rotateEpoch({
    keyringPath: path,
    rootKeyPath: rootKey,
    epochSeconds: EPOCH_SECONDS,
    graceSeconds: 86_400,
    now,
  });
  return path;
}

async function issuerOn(keyringPath: string): Promise<IssuerHarness> {
  const harness = await startIssuer({ keyringPath, bundleSize: 1 });
  started.push(harness);
  return harness;
}

async function health(harness: IssuerHarness): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}/healthz`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('GET /healthz', () => {
  it('reports ok while the current epoch can still sign', async () => {
    const harness = await issuerOn(await keyringRotatedAt(new Date()));

    const { status, body } = await health(harness);

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.epoch).toBe(harness.keyDocument.epoch_id);
    expect(body.expires_in_seconds).toBeGreaterThan(EPOCH_SECONDS - 60);
  });

  // The failure this exists to catch: nothing rotates the keyring by itself, so
  // an unattended issuer eventually advertises a key document nobody can buy
  // against. It answers requests and passes a naive liveness check throughout.
  it('fails once the current epoch has expired, and issuance really has stopped', async () => {
    const longExpired = new Date(Date.now() - (EPOCH_SECONDS + 86_400) * 1000);
    const harness = await issuerOn(await keyringRotatedAt(longExpired));

    const { status, body } = await health(harness);

    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.expires_in_seconds).toBeLessThan(0);

    // Not a decorative check: a purchase against the advertised epoch is
    // refused, which is exactly what the 503 is claiming.
    const prepared = await new RsaBlinder().prepare(1, harness.keyDocument.pubkey);
    const purchase = await fetch(`${harness.url}/v1/bundles`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment-claim': await claimHeader(uniquePaymentRef()),
      },
      body: JSON.stringify({
        epoch: harness.keyDocument.epoch_id,
        blinded_blanks: [...prepared.blindedBlanks],
      }),
    });

    expect(purchase.status).toBe(400);
    expect(await errorCode(purchase)).toBe('WRONG_EPOCH');
  });
});
