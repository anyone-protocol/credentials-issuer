# Payment claim interface (proposed)

**Status: proposed, not agreed.** The scope doc (M1.4) names this as "the one interface requiring
TOON agreement" and asks for it to be settled during M0. This is our concrete proposal, implemented
in the M0.1 stub so TOON has something running to build against. Nothing here is final until TOON
signs off; the shape is expected to change.

## Transport

The fronting proxy forwards proof of payment in a request header:

```
X-Payment-Claim: <base64url(JSON)>
```

A header rather than a body field, because the proxy adds the claim to a request whose body
(`{epoch, blinded_blanks[]}`) is built by the buyer. Splicing JSON in the proxy would mean parsing
and re-serializing a payload that, by invariant I2, the proxy has no reason to touch.

## Payload

The decoded JSON is the object the scope doc specifies for M1.4:

```json
{
  "payment_ref": "string, required",
  "amount": "string, decimal",
  "route_id": "string",
  "proxy_sig": "string, base64"
}
```

`payment_ref` is the only field the issuer consumes today. It keys the retention record (I5) and,
from M0.2, the rate limiter.

## What the issuer checks, by milestone

| Milestone | Checked |
| --------- | ------- |
| M0.1 (now) | Header present, decodes as base64url JSON, carries a non-empty `payment_ref`. |
| M0.2 | Rate limit keyed by `payment_ref`, never by IP (I5). Idempotency keys scoped per `payment_ref`. |
| M1.4 | `proxy_sig` verifies, and `amount` matches the bundle price. |

Until M1.4 the issuer trusts any well-formed claim. The stub is not an authorization boundary and
must not be exposed outside the sandbox.

## Failure

A missing or malformed claim returns `402 Payment Required` with the typed error `CLAIM_INVALID`:

```json
{ "error": { "code": "CLAIM_INVALID", "message": "missing payment claim" } }
```

`402` because the issuer sits behind a proxy whose whole job is the payment flow, so a request
arriving without a claim means payment has not been established.

## Open questions for TOON

1. **Claim freshness.** The payload has no timestamp or nonce. M0.2 idempotency stops a *retry*
   double-counting, but it does not stop a captured claim being reused for a genuinely new bundle:
   nothing yet caps how many bundles one `payment_ref` may buy. That cap is the payment-side check
   in M1.4. Should the claim also carry its own expiry, so a leaked claim ages out?
2. **`proxy_sig` scope.** Does the signature cover the claim fields only, or also bind the request
   body (the blinded blanks)? Body-binding prevents a claim being re-pointed at a different bundle,
   at the cost of the proxy hashing a payload it otherwise ignores.
3. **Key distribution.** How does the issuer learn the proxy's public key, and how is it rotated?
4. **`amount` encoding.** Decimal string, or integer base units of $ANYONE? Base units avoid
   float-parsing disagreements at the price comparison in M1.4.
5. **Error taxonomy.** Two codes are ours, not the scope doc's: `REQUEST_INVALID` (400) for a
   malformed envelope, and `IDEMPOTENCY_CONFLICT` (409) for a key reused with a different body.
   Confirm the names, or tell us the codes you want.
