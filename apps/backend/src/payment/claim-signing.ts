/**
 * The exact bytes proxy_sig covers.
 *
 * Keys are emitted in this fixed order so both sides produce identical bytes
 * without needing a canonical-JSON library. The harness reimplements this
 * independently (packages/buyer-harness/src/claim.ts) rather than importing it,
 * so a change here that the client does not match shows up as a test failure
 * instead of passing silently.
 *
 * Provisional, pending TOON agreement. See docs/payment-claim.md.
 */
export interface SignedClaimFields {
  readonly payment_ref: string;
  readonly amount: string;
  readonly route_id: string;
}

export function canonicalClaimPayload(fields: SignedClaimFields) {
  const ordered = JSON.stringify({
    amount: fields.amount,
    payment_ref: fields.payment_ref,
    route_id: fields.route_id,
  });
  // Copied into a fresh ArrayBuffer for WebCrypto's BufferSource.
  const encoded = new TextEncoder().encode(ordered);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
}

export const PROXY_SIGNATURE_ALGORITHM = 'Ed25519';
