import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { DEV_PROXY_KEY_PEM } from '../../../../scripts/generate-dev-keys';
import {
  importProxySigningKey,
  signPaymentClaim,
} from '../../../../packages/buyer-harness/src/claim';
import {
  claimHeader,
  errorCode,
  postBundle,
  startIssuer,
  uniquePaymentRef,
  validBlanks,
  type IssuerHarness,
} from '../testing/issuer-harness';
import { scenario } from '../testing/scenario';
import { ClaimRejections } from './claim-rejections.service';

describe('payment claim verification', () => {
  let harness: IssuerHarness;
  let rejections: ClaimRejections;

  beforeAll(async () => {
    harness = await startIssuer();
    rejections = harness.app.get(ClaimRejections);
  });
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.dataSource.query('TRUNCATE TABLE issuance_record, idempotency_record');
  });

  const issuanceCount = async (paymentRef: string): Promise<number> =>
    (
      await harness.dataSource.query('SELECT * FROM issuance_record WHERE payment_ref = $1', [
        paymentRef,
      ])
    ).length;

  scenario('valid proxy claim admits issuance', async () => {
    const paymentRef = uniquePaymentRef();

    const response = await postBundle(
      harness,
      { epoch: '0', blinded_blanks: await validBlanks(harness) },
      { paymentRef },
    );

    expect(response.status).toBe(201);
    // "and bundles_paid is incremented once"
    expect(await issuanceCount(paymentRef)).toBe(1);
  });

  scenario('invalid claim is rejected without signing', async () => {
    const signingKey = await importProxySigningKey(await readFile(DEV_PROXY_KEY_PEM, 'utf8'));

    const badSignature = await (async () => {
      const paymentRef = uniquePaymentRef();
      const honest = await signPaymentClaim(
        { payment_ref: paymentRef, amount: '1.00', route_id: 'route-1' },
        signingKey,
      );
      // Same claim, signature re-pointed at a different payment_ref.
      const claim = JSON.parse(Buffer.from(honest, 'base64url').toString('utf8'));
      claim.payment_ref = uniquePaymentRef();
      return Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
    })();

    const cases: { name: string; claim?: string; amount?: string; reason: string }[] = [
      { name: 'bad proxy_sig', claim: badSignature, reason: 'bad_signature' },
      { name: 'mismatched amount', amount: '0.01', reason: 'amount_mismatch' },
    ];

    for (const testCase of cases) {
      const before = await rejections.countFor(testCase.reason as never);
      const paymentRef = uniquePaymentRef();

      const response = await postBundle(
        harness,
        { epoch: '0', blinded_blanks: await validBlanks(harness) },
        testCase.claim
          ? { claim: testCase.claim }
          : { paymentRef, amount: testCase.amount },
      );

      expect(response.status).toBe(402);
      expect(await errorCode(response)).toBe('CLAIM_INVALID');
      // "And nothing is signed"
      expect(await harness.dataSource.query('SELECT * FROM issuance_record')).toHaveLength(0);
      // "and a rejection counter is incremented"
      expect(await rejections.countFor(testCase.reason as never)).toBe(before + 1);
    }
  });

  // Not a scope scenario: an unsigned claim was accepted before M1.4, so this
  // pins that the old behaviour is gone.
  it('rejects a claim carrying no proxy_sig at all', async () => {
    const unsigned = Buffer.from(
      JSON.stringify({ payment_ref: uniquePaymentRef(), amount: '1.00', route_id: 'route-1' }),
      'utf8',
    ).toString('base64url');

    const response = await postBundle(
      harness,
      { epoch: '0', blinded_blanks: await validBlanks(harness) },
      { claim: unsigned },
    );

    expect(response.status).toBe(402);
    expect(await errorCode(response)).toBe('CLAIM_INVALID');
  });

  it('accepts an equal price written with different trailing zeros', async () => {
    const paymentRef = uniquePaymentRef();
    const claim = await claimHeader(paymentRef, { amount: '1.000' });

    const response = await postBundle(
      harness,
      { epoch: '0', blinded_blanks: await validBlanks(harness) },
      { claim },
    );

    expect(response.status).toBe(201);
  });
});
