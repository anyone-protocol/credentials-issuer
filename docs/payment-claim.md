# The payment claim

The interface between the fronting proxy and the issuer: the proxy's signed statement that a request
was paid for. Scope M1.4 calls it "the one interface requiring TOON agreement".

**Status: the wire format is settled and implemented on both sides.** TOON's implementation is
[toon-protocol/anytoon](https://github.com/toon-protocol/anytoon), whose
[docs/payment-claim.md](https://github.com/toon-protocol/anytoon/blob/master/docs/payment-claim.md)
describes the same interface from their side; the two documents should agree, and if they ever
disagree that is a bug in one of them. Their `canonicalClaimPayload` and ours produce identical
bytes. What is *not* settled is replay protection, at the end of this page.

## Wire format

The claim travels in the `X-Payment-Claim` request header, as base64url of a UTF-8 JSON object:

```json
{
  "payment_ref": "<identity the payment is attributed to>",
  "amount": "<exact decimal, e.g. 0.01>",
  "route_id": "<the route the payment was collected on>",
  "proxy_sig": "<base64url of a raw 64-byte Ed25519 signature>"
}
```

`proxy_sig` covers the other three fields and not itself. The signed bytes are UTF-8 of a JSON
object with **exactly these three keys, alphabetically ordered, no whitespace**:

```
{"amount":"0.01","payment_ref":"evm:0x1111...","route_id":"g.anyone.credentials"}
```

The fixed ordering stands in for canonical JSON so neither side needs a canonicalization library. It
is load-bearing: any difference produces a signature that verifies nowhere, and the only symptom is
a 402 on a request the buyer already paid for. The signature is pure Ed25519 (RFC 8032, no prehash,
no context).

This repo carries three independent implementations of those bytes on purpose --
[claim-signing.ts](../apps/backend/src/payment/claim-signing.ts), the buyer harness's
[claim.ts](../packages/buyer-harness/src/claim.ts), and TOON's minter -- so a change on one side
that another does not match fails a test rather than becoming a silent 402.
[test-vectors/payment-claim.json](../test-vectors/payment-claim.json) pins a worked example.

## Verification, in order

[claim-verifier.service.ts](../apps/backend/src/payment/claim-verifier.service.ts):

1. parse the header as base64url JSON, requiring a non-empty `payment_ref`,
2. require `amount`, `route_id` and `proxy_sig` present and non-empty,
3. verify `proxy_sig` over the canonical bytes under the configured proxy public key,
4. compare `amount` to the configured `BUNDLE_PRICE`, by exact decimal value.

**3 before 4 is deliberate:** an unsigned caller must not be able to learn the price by observing
which error comes back. Every rejection increments a counter by reason, so a proxy sending claims we
will not honour is visible rather than silent.

Anything that fails is a typed `CLAIM_INVALID` and nothing is signed.

## Field semantics

**`payment_ref` names a payer, not a request.** It is the identity the payment is attributed to,
stable for a given payer across requests. TOON uses the paying channel identity
([their ADR 0002](https://github.com/toon-protocol/anytoon/blob/master/docs/adr/0002-payment-reference-is-the-paying-channel-identity.md)).
That choice is what makes the issuer's own design work: the rate limiter keys on it so limits follow
the payer rather than an IP (I5), and idempotent retries key on it, so a retry with the same
`Idempotency-Key` returns the original bundle instead of buying a second one.

> **Therefore the issuer must not enforce a unique `payment_ref` per request.** Doing so would put
> every request in a fresh rate-limit bucket and break idempotent retries. This was an open question
> to TOON; it is now answered, in the opposite direction to what this repo originally proposed.

**`amount`** is an exact decimal string compared by value, so trailing zeros do not matter. It
carries no currency or chain and is meaningful only against a price both sides configured.

**`route_id`** is the route the payment was collected on. Signed and retained, not otherwise checked.

**The price is enforced twice.** The proxy prices the route and the issuer independently refuses an
amount that is not its own `BUNDLE_PRICE`, so a proxy cannot mint a mismatched amount without
invalidating its own signature. It also means **the two prices must agree exactly or nothing can
ever be bought** -- every request returns `CLAIM_INVALID`. TOON's deployment uses `0.01`; this repo's
default is `1.00`, and one of them has to move before a real integration.

## The gap: a claim is replayable

A claim carries no nonce, no timestamp and no expiry, and nothing records that one has been used.
Anyone holding a valid claim can buy bundles with it until the rate limit stops them, and nothing
ties a claim to the blanks it paid for, so a claim valid for one issuance is valid for any issuance
at the same price.

Two consequences for anyone implementing the proxy role, which TOON's docs also state: **a claim
must never leave the trusted network**, and **an inbound claim from a caller must be discarded
rather than forwarded**, because the issuer cannot tell the difference.

**The fix, and the open decision.** Add `nonce` and an expiry to the signed fields and have the
issuer record spent nonces for the expiry window. TOON has said this is upstream's call and that
they are built so they need only start populating the new fields. It is a decision for the scope
owner, not a change to make here unilaterally:

- it adds per-request state to a service whose retention invariant (I5) is deliberately narrow,
  though a nonce and an expiry are strictly less than what is already retained,
- the expiry window has to be long enough to survive a slow buyer and short enough that the spent
  set stays small,
- it must not be keyed on `payment_ref` uniqueness, for the reasons above.
