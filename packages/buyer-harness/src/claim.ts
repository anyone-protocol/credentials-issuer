/**
 * Client-side construction of the proxy's payment claim.
 *
 * The canonical payload is reimplemented here rather than shared with the
 * issuer on purpose: the harness is a conformance tool, so if the two ever
 * disagree about the bytes proxy_sig covers, a test must fail rather than both
 * sides being wrong together.
 *
 * Provisional, pending TOON agreement. See docs/payment-claim.md.
 */
export const PAYMENT_CLAIM_HEADER = 'x-payment-claim';
export const PROXY_SIGNATURE_ALGORITHM = 'Ed25519';

export interface PaymentClaimFields {
  readonly payment_ref: string;
  readonly amount: string;
  readonly route_id: string;
}

export function canonicalClaimPayload(fields: PaymentClaimFields) {
  const ordered = JSON.stringify({
    amount: fields.amount,
    payment_ref: fields.payment_ref,
    route_id: fields.route_id,
  });
  const encoded = new TextEncoder().encode(ordered);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
}

const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';
const PKCS8_FOOTER = '-----END PRIVATE KEY-----';

/** Imports the proxy's Ed25519 signing key from a PKCS#8 PEM. */
export function importProxySigningKey(pem: string): Promise<CryptoKey> {
  const body = pem.trim();
  if (!body.startsWith(PKCS8_HEADER) || !body.endsWith(PKCS8_FOOTER)) {
    throw new Error('expected an unencrypted PKCS#8 private key PEM');
  }
  const der = Buffer.from(
    body.slice(PKCS8_HEADER.length, body.length - PKCS8_FOOTER.length).replace(/\s+/g, ''),
    'base64',
  );
  const bytes = new Uint8Array(der.byteLength);
  bytes.set(der);
  return crypto.subtle.importKey('pkcs8', bytes, { name: PROXY_SIGNATURE_ALGORITHM }, true, ['sign']);
}

/** The `X-Payment-Claim` header value for a signed claim. */
export async function signPaymentClaim(
  fields: PaymentClaimFields,
  signingKey: CryptoKey,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: PROXY_SIGNATURE_ALGORITHM },
    signingKey,
    canonicalClaimPayload(fields),
  );
  const claim = {
    ...fields,
    proxy_sig: Buffer.from(signature).toString('base64url'),
  };
  return Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
}

/** Unsigned claim. The issuer rejects these from M1.4; kept for negative tests. */
export function encodePaymentClaim(paymentRef: string): string {
  return Buffer.from(JSON.stringify({ payment_ref: paymentRef }), 'utf8').toString('base64url');
}
