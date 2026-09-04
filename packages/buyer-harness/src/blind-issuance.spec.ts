import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startIssuer, type IssuerHarness } from '../../../apps/backend/src/testing/issuer-harness';
import { scenario } from '../../../apps/backend/src/testing/scenario';
import { RsaBlinder } from './blinding';
import { BLIND_SIGNATURE_SUITE } from './conformance';
import { purchaseBundle } from './purchase';

describe('real blind issuance', () => {
  let issuer: IssuerHarness;

  beforeAll(async () => {
    issuer = await startIssuer();
  });
  afterAll(() => issuer.close());

  scenario('issued signature verifies after unblinding', async () => {
    const { bundleSize, blankSizeBytes, signatureSizeBytes } = issuer.config;

    const result = await purchaseBundle({
      baseUrl: issuer.url,
      paymentRef: 'pay-blind-1',
      parameters: { bundleSize, blankSizeBytes, signatureSizeBytes },
    });

    expect(result.conformance.passed).toBe(true);
    expect(result.credentials).toHaveLength(bundleSize);

    // "Then the resulting signature verifies under the epoch public key"
    const verified = result.conformance.checks.find((c) => c.name === 'signature verifies');
    expect(verified?.passed).toBe(true);

    // "And the suite used is RSABSSA-SHA384-PSS-Randomized"
    expect(new RsaBlinder().name).toBe(BLIND_SIGNATURE_SUITE);
    const suite = result.conformance.checks.find((c) => c.name === 'key document suite');
    expect(suite?.detail).toBe(BLIND_SIGNATURE_SUITE);
  });

  it('rejects a signature finalized against a different epoch key', async () => {
    const otherIssuerKey = await new RsaBlinder().prepare(1, issuer.keyDocument.pubkey);
    // A blind signature from nowhere: right size, wrong provenance.
    const forged = Buffer.alloc(issuer.config.signatureSizeBytes, 9).toString('base64');

    await expect(otherIssuerKey.finalize([forged])).rejects.toThrow();
  });
});
