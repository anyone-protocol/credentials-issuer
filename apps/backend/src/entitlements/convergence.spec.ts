import { afterAll, beforeAll, beforeEach, describe, expect } from 'bun:test';
import {
  postBundle,
  postPickup,
  prepareBundle,
  registerEntitlement,
  startIssuer,
  type IssuerHarness,
} from '../testing/issuer-harness';
import { scenario } from '../testing/scenario';

/**
 * Blob contents differ by construction -- they sign different serials -- so
 * the comparison is over everything else: field names, ordering, value types
 * and blob sizes. An extra field on either rail fails this.
 */
function wireShape(body: Record<string, unknown>): unknown {
  return Object.fromEntries(
    Object.entries(body)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.map((blob) => `<${Buffer.from(String(blob), 'base64').byteLength} bytes>`)
          : value,
      ]),
  );
}

// Scenario name below is verbatim from docs/issuer-mvp-scope.md (M2.2).
describe('convergent issuance', () => {
  let harness: IssuerHarness;

  beforeAll(async () => {
    harness = await startIssuer();
  });
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.dataSource.query(
      'TRUNCATE TABLE issuance_record, idempotency_record, epoch_counter, entitlement',
    );
  });

  scenario('fiat and crypto credentials are indistinguishable', async () => {
    const epoch = harness.keyDocument.epoch_id;
    const paidBlinding = await prepareBundle(harness);
    const dripBlinding = await prepareBundle(harness);
    const { entitlement_id: entitlementId } = await registerEntitlement(harness);

    const paid = await postBundle(harness, {
      epoch,
      blinded_blanks: [...paidBlinding.blindedBlanks],
    });
    const drip = await postPickup(harness, entitlementId, {
      epoch,
      blinded_blanks: [...dripBlinding.blindedBlanks],
    });

    // Same status and media type: the rail must not be readable off the
    // response envelope either.
    expect(paid.status).toBe(201);
    expect(drip.status).toBe(paid.status);
    expect(drip.headers.get('content-type')).toBe(paid.headers.get('content-type'));

    const paidBody = (await paid.json()) as { epoch: string; blind_signatures: string[] };
    const dripBody = (await drip.json()) as { epoch: string; blind_signatures: string[] };

    // "identical in size and structure with no rail-identifying field"
    expect(Object.keys(dripBody).sort()).toEqual(['blind_signatures', 'epoch']);
    expect(wireShape(dripBody)).toEqual(wireShape(paidBody));

    // The credentials themselves, as a redeeming exit would see them. Both
    // finalize and verify under the one epoch public key, so neither rail
    // carries its own anonymity set -- which is the property the identical
    // wire format is there to protect.
    const paidCredentials = await paidBlinding.finalize(paidBody.blind_signatures);
    const dripCredentials = await dripBlinding.finalize(dripBody.blind_signatures);

    for (const credential of [...paidCredentials, ...dripCredentials]) {
      expect(await paidBlinding.verify(credential)).toBe(true);
    }

    const sizes = (credentials: typeof paidCredentials) =>
      credentials.map(({ message, signature }) => [
        Buffer.from(message, 'base64').byteLength,
        Buffer.from(signature, 'base64').byteLength,
      ]);
    expect(sizes(dripCredentials)).toEqual(sizes(paidCredentials));
  });
});
