import { randomBytes } from 'node:crypto';
import { importProxySigningKey, signPaymentClaim, type PaymentClaimFields } from './claim';

/**
 * What a fronting proxy asks for in a 402. Provisional and pending TOON
 * agreement: see docs/payment-claim.md. Only `amount` is treated as required;
 * everything else is carried through to the payment provider untouched, so an
 * added field does not need a harness release.
 */
export interface PaymentRequirement {
  readonly amount?: string;
  readonly asset?: string;
  readonly chain?: string;
  readonly recipient?: string;
  readonly route_id?: string;
  readonly nonce?: string;
  readonly expires_at?: string;
  readonly [key: string]: unknown;
}

/** Headers to add to the retried request. */
export type RetryHeaders = Readonly<Record<string, string>>;

export interface PaymentProvider {
  readonly name: string;
  /** Headers to send on the first attempt, before any 402. */
  initialHeaders(): RetryHeaders;
  /** Settles a 402 and returns the headers that make the retry succeed. */
  pay(requirement: PaymentRequirement): Promise<RetryHeaders>;
}

export const PAYMENT_RECEIPT_HEADER = 'x-payment';

export class PaymentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRequiredError';
  }
}

/**
 * Talks straight to an issuer with a synthetic claim, as if a proxy had already
 * forwarded one. The default, because it is what testing an issuer directly
 * needs; it cannot satisfy a 402.
 */
export class StubClaimProvider implements PaymentProvider {
  readonly name = 'stub-claim';

  /** Takes a finished header value: signing is async, initialHeaders is not. */
  constructor(private readonly claimHeaderValue: string) {}

  initialHeaders(): RetryHeaders {
    return { 'x-payment-claim': this.claimHeaderValue };
  }

  async pay(): Promise<RetryHeaders> {
    throw new PaymentRequiredError(
      'issuer returned 402 but --payment stub-claim cannot pay; use --payment stub-receipt behind a proxy',
    );
  }
}

/**
 * Drives the full request -> 402 -> pay -> retry flow with the payment itself
 * stubbed: it fabricates a receipt rather than moving $ANYONE. Real settlement
 * lands when the channel contracts are on Sepolia; only pay() changes.
 */
export class StubReceiptProvider implements PaymentProvider {
  readonly name = 'stub-receipt';

  constructor(private readonly payer = `0x${randomBytes(20).toString('hex')}`) {}

  initialHeaders(): RetryHeaders {
    return {};
  }

  async pay(requirement: PaymentRequirement): Promise<RetryHeaders> {
    const receipt = {
      payer: this.payer,
      tx_hash: `0x${randomBytes(32).toString('hex')}`,
      amount: requirement.amount,
      route_id: requirement.route_id,
      nonce: requirement.nonce,
    };
    return {
      [PAYMENT_RECEIPT_HEADER]: Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url'),
    };
  }
}

/** Sends nothing. Useful for checking that a proxy actually gates the route. */
export class NoPaymentProvider implements PaymentProvider {
  readonly name = 'none';

  initialHeaders(): RetryHeaders {
    return {};
  }

  async pay(): Promise<RetryHeaders> {
    throw new PaymentRequiredError('payment required, and --payment none was requested');
  }
}

export function parsePaymentRequirement(body: unknown): PaymentRequirement {
  if (typeof body !== 'object' || body === null) return {};
  const payment = (body as { payment?: unknown }).payment;
  return typeof payment === 'object' && payment !== null ? (payment as PaymentRequirement) : {};
}

/**
 * Builds a claim signed as the proxy would sign it. Standing in for the proxy
 * needs its signing key, which only a sandbox or a local run should ever have.
 */
export async function createStubClaimProvider(
  fields: PaymentClaimFields,
  proxySigningKeyPem: string,
): Promise<StubClaimProvider> {
  const key = await importProxySigningKey(proxySigningKeyPem);
  return new StubClaimProvider(await signPaymentClaim(fields, key));
}
