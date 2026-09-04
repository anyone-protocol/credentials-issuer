import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { scenario } from '../testing/scenario';
import {
  errorCode,
  postBundle,
  startIssuer,
  uniquePaymentRef,
  validBlanks,
  type IssuerHarness,
} from '../testing/issuer-harness';

// M0.2. Every test uses its own payment_ref, so the per-ref rate-limit budgets
// are independent and nothing carries between tests or between runs.
describe('request hygiene', () => {
  let harness: IssuerHarness;

  beforeAll(async () => {
    harness = await startIssuer({ rateLimitMax: 3, bundleSize: 2 });
  });
  afterAll(() => harness.close());

  const body = async () => ({ epoch: harness.keyDocument.epoch_id, blinded_blanks: await validBlanks(harness) });

  const issuanceCount = async (paymentRef: string): Promise<number> => {
    const rows = await harness.dataSource.query(
      'SELECT * FROM issuance_record WHERE payment_ref = $1',
      [paymentRef],
    );
    return rows.length;
  };

  scenario('replayed idempotency key does not double-issue', async () => {
    const paymentRef = uniquePaymentRef();
    const request = await body();

    const first = await postBundle(harness, request, { paymentRef, idempotencyKey: 'K' });
    expect(first.status).toBe(201);
    const original = await first.json();

    const replay = await postBundle(harness, request, { paymentRef, idempotencyKey: 'K' });

    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(original);
    expect(await issuanceCount(paymentRef)).toBe(1);
  });

  scenario('rate limit is per payment_ref', async () => {
    const limited = uniquePaymentRef();
    const unaffected = uniquePaymentRef();

    for (let sent = 0; sent < harness.config.rateLimitMax; sent += 1) {
      expect((await postBundle(harness, await body(), { paymentRef: limited })).status).toBe(201);
    }

    const blocked = await postBundle(harness, await body(), { paymentRef: limited });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('RATE_LIMITED');

    expect((await postBundle(harness, await body(), { paymentRef: unaffected })).status).toBe(201);
  });

  // Not a scope scenario. Without this, reusing a key for a different request
  // would sign without counting, which is overissuance (M1.3).
  it('rejects an idempotency key reused for a different request', async () => {
    const paymentRef = uniquePaymentRef();

    await postBundle(harness, await body(), { paymentRef, idempotencyKey: 'K' });
    const conflicting = await postBundle(harness, await body(), { paymentRef, idempotencyKey: 'K' });

    expect(conflicting.status).toBe(409);
    expect(await errorCode(conflicting)).toBe('IDEMPOTENCY_CONFLICT');
    expect(await issuanceCount(paymentRef)).toBe(1);
  });
});
