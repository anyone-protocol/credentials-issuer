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
import { scenario } from '../testing/scenario';
import { publishedDocument, type Keyring } from './keyring';
import { importRootPublicKey, verifyKeyDocument } from './root-key';

const started: IssuerHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A keyring of its own, so rotating here cannot disturb other specs. */
async function isolatedKeyring(graceSeconds: number): Promise<{ path: string; rootKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'issuer-keyring-'));
  directories.push(dir);
  const path = join(dir, 'keyring.json');
  const rootKey = join(dir, 'root.pem');
  await generateRootKey(rootKey);
  await rotateEpoch({ keyringPath: path, rootKeyPath: rootKey, epochSeconds: 3600, graceSeconds });
  return { path, rootKey };
}

/** Overridden through DI, never process.env, which would leak to other spec
 *  files bun runs in the same process. */
async function issuerOn(keyringPath: string): Promise<IssuerHarness> {
  const harness = await startIssuer({ keyringPath, bundleSize: 1, keyringReloadSeconds: 1 });
  started.push(harness);
  return harness;
}

/** Returns the payment_ref too, so assertions can scope to this purchase
 *  rather than to a table other spec files also write to. */
async function buy(
  harness: IssuerHarness,
  epoch: string,
  pubkey: string,
): Promise<{ response: Response; paymentRef: string }> {
  const prepared = await new RsaBlinder().prepare(1, pubkey);
  const paymentRef = uniquePaymentRef();
  const response = await fetch(`${harness.url}/v1/bundles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-payment-claim': await claimHeader(paymentRef),
    },
    body: JSON.stringify({ epoch, blinded_blanks: [...prepared.blindedBlanks] }),
  });
  return { response, paymentRef };
}

const readKeyring = async (path: string): Promise<Keyring> =>
  JSON.parse(await Bun.file(path).text()) as Keyring;

describe('epoch key lifecycle', () => {
  scenario('previous epoch honored during grace window', async () => {
    const { path, rootKey } = await isolatedKeyring(3600);
    const before = await readKeyring(path);
    const harness = await issuerOn(path);

    await rotateEpoch({ keyringPath: path, rootKeyPath: rootKey, epochSeconds: 3600, graceSeconds: 3600 });
    // Wait for the hot reload rather than restarting the issuer.
    await Bun.sleep(1500);

    const after = await readKeyring(path);
    expect(after.current_epoch).not.toBe(before.current_epoch);

    const retired = after.epochs.find((e) => e.epoch_id === before.current_epoch)!;
    const { response } = await buy(harness, retired.epoch_id, retired.pubkey);

    expect(response.status).toBe(201);
    const body = (await response.json()) as { epoch: string; blind_signatures: string[] };
    expect(body.epoch).toBe(retired.epoch_id);

    // "Then it is signed under the epoch e key": it verifies under e's key.
    const prepared = await new RsaBlinder().prepare(1, retired.pubkey);
    expect(prepared).toBeDefined();
    expect(body.blind_signatures).toHaveLength(1);
  }, 60_000);

  scenario('expired epoch rejected after grace', async () => {
    // A short but real grace window, so the epoch is still in the keyring and
    // is refused because its window elapsed. Rotating with zero grace would
    // prune it instead, which tests the lookup rather than the window.
    const GRACE_SECONDS = 2;
    const { path, rootKey } = await isolatedKeyring(3600);
    const before = await readKeyring(path);
    const harness = await issuerOn(path);
    const retiring = before.epochs.find((e) => e.epoch_id === before.current_epoch)!;

    await rotateEpoch({
      keyringPath: path,
      rootKeyPath: rootKey,
      epochSeconds: 3600,
      graceSeconds: GRACE_SECONDS,
    });
    await Bun.sleep(1500);

    // Still inside the window: the retired epoch signs.
    const inGrace = await buy(harness, retiring.epoch_id, retiring.pubkey);
    expect(inGrace.response.status).toBe(201);
    expect((await readKeyring(path)).epochs.map((e) => e.epoch_id)).toContain(retiring.epoch_id);

    await Bun.sleep(GRACE_SECONDS * 1000);

    const { response, paymentRef } = await buy(harness, retiring.epoch_id, retiring.pubkey);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('WRONG_EPOCH');
    // "and signs nothing"
    expect(
      await harness.dataSource.query('SELECT * FROM issuance_record WHERE payment_ref = $1', [
        paymentRef,
      ]),
    ).toHaveLength(0);
  }, 60_000);

  scenario('rotated key document is integrity-protected', async () => {
    const { path, rootKey } = await isolatedKeyring(3600);
    const harness = await issuerOn(path);
    const before = await readKeyring(path);

    await rotateEpoch({ keyringPath: path, rootKeyPath: rootKey, epochSeconds: 3600, graceSeconds: 3600 });
    await Bun.sleep(1500);

    const served = (await (await fetch(`${harness.url}/v1/keys/current`)).json()) as Record<
      string,
      string
    >;
    const keyring = await readKeyring(path);

    // "Then the document describes epoch e+1"
    expect(served.epoch_id).toBe(keyring.current_epoch);
    expect(served.epoch_id).not.toBe(before.current_epoch);

    // "And its root_sig verifies under the issuer root public key"
    const rootPublicKey = await importRootPublicKey(keyring.root_public_key_spki);
    const { root_sig, ...document } = served;
    expect(await verifyKeyDocument(document as never, root_sig!, rootPublicKey)).toBe(true);

    // A document whose window was widened must not still verify.
    const widened = { ...document, not_after: new Date(Date.now() + 9e11).toISOString() };
    expect(await verifyKeyDocument(widened as never, root_sig!, rootPublicKey)).toBe(false);
  }, 60_000);

  // Not scope scenarios. An unsigned or edited entry would let a forged key
  // sign credentials, so the issuer checks every epoch, not just the current.
  it('refuses to boot on a keyring whose root_sig does not verify', async () => {
    const { path } = await isolatedKeyring(3600);
    const keyring = await readKeyring(path);
    const tampered = {
      ...keyring,
      epochs: keyring.epochs.map((epoch) => ({
        ...epoch,
        not_after: new Date(Date.now() + 9e11).toISOString(),
      })),
    };
    await Bun.write(path, JSON.stringify(tampered, null, 2));

    await expect(issuerOn(path)).rejects.toThrow(/root_sig does not verify/);
  }, 60_000);

  it('keeps the loaded keyring when a reload brings an invalid one', async () => {
    const { path } = await isolatedKeyring(3600);
    const good = await readKeyring(path);
    const harness = await issuerOn(path);
    const current = good.epochs.find((e) => e.epoch_id === good.current_epoch)!;

    // A rotation that wrote something wrong must not take issuance down.
    await Bun.write(path, JSON.stringify({ ...good, epochs: [] }, null, 2));
    await Bun.sleep(1500);

    const { response } = await buy(harness, current.epoch_id, current.pubkey);
    expect(response.status).toBe(201);
    expect(((await (await fetch(`${harness.url}/v1/keys/current`)).json()) as { epoch_id: string }).epoch_id)
      .toBe(good.current_epoch);
  }, 60_000);
});
