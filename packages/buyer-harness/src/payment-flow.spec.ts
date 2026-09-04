import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startIssuer, type IssuerHarness } from '../../../apps/backend/src/testing/issuer-harness';
import { purchaseBundle } from './purchase';
import { NoPaymentProvider, StubClaimProvider, StubReceiptProvider } from './payment';
import { startFakeProxy, type FakeProxy } from './testing/fake-proxy';

/**
 * The request -> 402 -> pay -> retry flow M0.3's scenario describes. That
 * scenario needs the real proxy on the Sepolia sandbox and stays unclaimed;
 * these tests cover the harness half against a stand-in proxy.
 */
describe('402 payment flow', () => {
  let issuer: IssuerHarness;
  let proxy: FakeProxy;

  beforeAll(async () => {
    issuer = await startIssuer();
    proxy = startFakeProxy({ issuerUrl: issuer.url });
  });
  afterAll(async () => {
    proxy.stop();
    await issuer.close();
  });

  const parameters = () => ({
    bundleSize: issuer.config.bundleSize,
    blankSizeBytes: issuer.config.blankSizeBytes,
    signatureSizeBytes: issuer.config.signatureSizeBytes,
  });

  it('answers a 402 and retries, receiving k verifiable credentials', async () => {
    const settledBefore = proxy.settled.length;

    const result = await purchaseBundle({
      baseUrl: proxy.url,
      paymentRef: 'unused-behind-a-proxy',
      payment: new StubReceiptProvider(),
      parameters: parameters(),
    });

    expect(result.paymentFlow).toBe('402-retry');
    expect(result.conformance.passed).toBe(true);
    expect(result.credentials).toHaveLength(issuer.config.bundleSize);
    // The proxy minted exactly one claim, so the retry was not sent twice.
    expect(proxy.settled.length).toBe(settledBefore + 1);
  });

  it('reports direct flow when talking to an issuer with no proxy in front', async () => {
    const result = await purchaseBundle({
      baseUrl: issuer.url,
      paymentRef: 'pay-direct-1',
      payment: new StubClaimProvider('pay-direct-1'),
      parameters: parameters(),
    });

    expect(result.paymentFlow).toBe('direct');
    expect(result.conformance.passed).toBe(true);
  });

  it('fails clearly when payment is required and the provider cannot pay', async () => {
    for (const payment of [new NoPaymentProvider(), new StubClaimProvider('pay-x')]) {
      await expect(
        purchaseBundle({
          baseUrl: proxy.url,
          paymentRef: 'pay-x',
          payment,
          parameters: parameters(),
        }),
      ).rejects.toThrow(/payment required|cannot pay/i);
    }
  });
});
