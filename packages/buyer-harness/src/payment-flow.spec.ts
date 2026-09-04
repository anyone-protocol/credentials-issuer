import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startIssuer, type IssuerHarness } from '../../../apps/backend/src/testing/issuer-harness';
import { purchaseBundle } from './purchase';
import { readFile } from 'node:fs/promises';
import { DEV_PROXY_KEY_PEM } from '../../../scripts/generate-dev-keys';
import {
  createStubClaimProvider,
  NoPaymentProvider,
  StubReceiptProvider,
} from './payment';
import { startFakeProxy, type FakeProxy } from './testing/fake-proxy';

/**
 * The request -> 402 -> pay -> retry flow M0.3's scenario describes. That
 * scenario needs the real proxy on the Sepolia sandbox and stays unclaimed;
 * these tests cover the harness half against a stand-in proxy.
 */
describe('402 payment flow', () => {
  let issuer: IssuerHarness;
  let proxy: FakeProxy;

  let proxyKeyPem: string;

  beforeAll(async () => {
    issuer = await startIssuer();
    proxyKeyPem = await readFile(DEV_PROXY_KEY_PEM, 'utf8');
    proxy = startFakeProxy({ issuerUrl: issuer.url, signingKeyPem: proxyKeyPem });
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
      payment: await createStubClaimProvider(
        { payment_ref: 'pay-direct-1', amount: '1.00', route_id: 'route-1' },
        proxyKeyPem,
      ),
      parameters: parameters(),
    });

    expect(result.paymentFlow).toBe('direct');
    expect(result.conformance.passed).toBe(true);
  });

  // A claim the issuer refuses also comes back as 402. Reporting that as
  // "cannot pay" would hide the real reason from anyone diagnosing an issuer.
  it('surfaces a rejected claim rather than trying to pay for it', async () => {
    await expect(
      purchaseBundle({
        baseUrl: issuer.url,
        paymentRef: 'pay-wrong-amount',
        payment: await createStubClaimProvider(
          { payment_ref: 'pay-wrong-amount', amount: '0.01', route_id: 'route-1' },
          proxyKeyPem,
        ),
        parameters: parameters(),
      }),
    ).rejects.toThrow(/CLAIM_INVALID/);
  });

  it('fails clearly when payment is required and the provider cannot pay', async () => {
    const cannotPay = [
      new NoPaymentProvider(),
      await createStubClaimProvider(
        { payment_ref: 'pay-x', amount: '1.00', route_id: 'route-1' },
        proxyKeyPem,
      ),
    ];
    for (const payment of cannotPay) {
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
