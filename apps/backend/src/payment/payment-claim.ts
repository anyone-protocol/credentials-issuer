import { IssuerException } from '../errors/issuer.exception';

export const PAYMENT_CLAIM_HEADER = 'x-payment-claim';

// Provisional shape, pending TOON agreement (scope M1.4). Only payment_ref is
// consumed in M0.1; proxy_sig and amount are verified in M1.4.
export interface PaymentClaim {
  readonly payment_ref: string;
  readonly amount?: string;
  readonly route_id?: string;
  readonly proxy_sig?: string;
}

function invalid(message: string): never {
  throw new IssuerException('CLAIM_INVALID', message);
}

export function parsePaymentClaim(header: string | undefined): PaymentClaim {
  if (!header) invalid('missing payment claim');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    invalid('payment claim is not base64url-encoded JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) invalid('payment claim is not an object');
  const claim = parsed as Record<string, unknown>;
  if (typeof claim.payment_ref !== 'string' || claim.payment_ref.length === 0) {
    invalid('payment claim is missing payment_ref');
  }

  return claim as unknown as PaymentClaim;
}
