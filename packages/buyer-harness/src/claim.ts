/** Provisional, pending TOON agreement. See docs/payment-claim.md. */
export function encodePaymentClaim(paymentRef: string): string {
  return Buffer.from(JSON.stringify({ payment_ref: paymentRef }), 'utf8').toString('base64url');
}
