import { encodePaymentClaim } from '../claim';
import { PAYMENT_RECEIPT_HEADER } from '../payment';

export interface FakeProxyOptions {
  /** The real issuer this proxy fronts. */
  readonly issuerUrl: string;
  readonly amount?: string;
  readonly routeId?: string;
}

export interface FakeProxy {
  readonly url: string;
  /** Payment refs the proxy minted, one per settled 402. */
  readonly settled: readonly string[];
  stop(): void;
}

/**
 * Stands in for the TOON proxy: gates /v1/bundles behind a 402, and on a paid
 * retry mints a payment claim and forwards to the real issuer. Deliberately
 * not an issuer itself, so the flow under test ends at real blind signatures.
 *
 * The 402 body and the receipt header are this repo's proposal, not an agreed
 * contract. See docs/payment-claim.md.
 */
export function startFakeProxy(options: FakeProxyOptions): FakeProxy {
  const settled: string[] = [];
  const issuer = options.issuerUrl.replace(/\/+$/, '');

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      // Buffered so the body survives being forwarded after the paid retry.
      const bodyText = request.method === 'GET' ? undefined : await request.text();
      const forward = (headers: Record<string, string> = {}) =>
        fetch(`${issuer}${pathname}`, {
          method: request.method,
          headers: { ...Object.fromEntries(request.headers), host: new URL(issuer).host, ...headers },
          body: request.method === 'GET' ? undefined : bodyText,
        });

      // Key documents are free: gating them would stop a buyer learning what
      // to blind against before they have paid for anything.
      if (pathname !== '/v1/bundles') return forward();

      const receipt = request.headers.get(PAYMENT_RECEIPT_HEADER);
      if (!receipt) {
        return Response.json(
          {
            error: { code: 'PAYMENT_REQUIRED', message: 'pay for this bundle, then retry' },
            payment: {
              amount: options.amount ?? '1.00',
              asset: 'ANYONE',
              chain: 'sepolia',
              recipient: '0x000000000000000000000000000000000000dEaD',
              route_id: options.routeId ?? 'route-1',
              nonce: crypto.randomUUID(),
            },
          },
          { status: 402 },
        );
      }

      // A real proxy verifies settlement on chain here. This one trusts the
      // receipt and mints the claim the issuer expects.
      const paymentRef = `proxy-${crypto.randomUUID()}`;
      settled.push(paymentRef);
      return forward({ 'x-payment-claim': encodePaymentClaim(paymentRef) });
    },
  });

  return { url: server.url.origin, settled, stop: () => server.stop(true) };
}
