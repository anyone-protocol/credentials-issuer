import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  importProxySigningKey,
  signPaymentClaim,
} from '../../../../packages/buyer-harness/src/claim';
import { canonicalClaimPayload } from './claim-signing';

const VECTOR = join(import.meta.dir, '../../../../test-vectors/payment-claim.json');

interface ClaimVector {
  proxy_private_key_pkcs8_pem: string;
  claim_fields: { payment_ref: string; amount: string; route_id: string };
  canonical_payload_utf8: string;
  proxy_sig_base64url: string;
  header_value: string;
}

// TOON implements claim signing in their proxy, and this vector is what they
// check against. If our implementation drifts from it, their working proxy
// would start being rejected, so the vector is pinned in both directions.
describe('published payment claim vector', () => {
  it('is reproduced exactly by this implementation', async () => {
    const vector = (await Bun.file(VECTOR).json()) as ClaimVector;

    expect(new TextDecoder().decode(canonicalClaimPayload(vector.claim_fields))).toBe(
      vector.canonical_payload_utf8,
    );

    const key = await importProxySigningKey(vector.proxy_private_key_pkcs8_pem);
    const header = await signPaymentClaim(vector.claim_fields, key);

    expect(header).toBe(vector.header_value);
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    expect(decoded.proxy_sig).toBe(vector.proxy_sig_base64url);
  });
});
