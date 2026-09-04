# TOON integration runbook

Get a real issuer running in a few minutes, drive a purchase through it, then read the two
interfaces your proxy has to implement. Nothing here needs a build: the image comes from the
registry.

The issuer sits **behind** your proxy. The buyer never talks to it directly, and it never talks to
a chain. Your proxy takes payment and vouches for it; the issuer trusts that voucher and signs.

```
buyer  ->  TOON proxy  ->  issuer
           402 + price      verifies X-Payment-Claim
           settles payment  blind-signs k blanks
           mints the claim
```

## Run it

Needs [Bun](https://bun.sh) and Docker or Podman.

```sh
git clone https://github.com/anyone-protocol/credentials-issuer
cd credentials-issuer
bun install
bun run keys:dev                                  # throwaway epoch + proxy keys, gitignored
docker compose -f compose.published.yml up        # pulls the image, runs migrations
```

```sh
curl localhost:3000/healthz
curl localhost:3000/v1/keys/current
```

Then buy a bundle with the harness, which is also your conformance tool:

```sh
bun run harness --url http://localhost:3000 --proxy-key config/keys/proxy.pem
```

```
PASS  bundle count: 10 blobs, as configured
PASS  signature size: all 10 blobs are 256 bytes
PASS  signature verifies: all 10 signatures verify under the epoch public key
```

Exit `0` conforming, `1` nonconforming (naming the failed checks), `2` if the run could not happen
at all. Point it at any deployment, including one of ours. Full options in
[buyer-harness.md](buyer-harness.md).

`bun run keys:dev` stands in for two keys that are yours and ours respectively in a real
deployment: the **epoch signing key** is ours, and the **proxy key** is yours. You generate the
proxy keypair, keep the private half, and send us the public half.

## Interface 1: the claim you forward to us

Every `POST /v1/bundles` must carry `X-Payment-Claim`, a base64url JSON object:

```json
{ "payment_ref": "...", "amount": "1.00", "route_id": "...", "proxy_sig": "..." }
```

`proxy_sig` is Ed25519 over the UTF-8 bytes of a JSON object with exactly these three keys, in this
order:

```
{"amount":"<amount>","payment_ref":"<payment_ref>","route_id":"<route_id>"}
```

Keys are alphabetical so both sides produce identical bytes without a canonical-JSON library.
`amount` must equal our `BUNDLE_PRICE`, compared as an exact decimal: `1.00`, `1.0` and `1` are the
same price, and no float is involved anywhere.

**Check your implementation against
[test-vectors/payment-claim.json](../test-vectors/payment-claim.json).** It carries a throwaway key,
the canonical payload, and the exact signature and header value. Ed25519 is deterministic, so a
correct implementation reproduces `proxy_sig` byte for byte without running anything. A test in this
repo pins the vector, so it cannot drift out from under you.

Verification happens before rate limiting, so a claim we cannot verify never spends a
`payment_ref`'s budget.

## Interface 2: the 402 you give buyers

The issuer never emits this; your proxy does. The harness implements what we propose, so
`--payment stub-receipt` exercises the whole flow against a stand-in proxy:

```
POST /v1/bundles        ->  402 Payment Required
X-Payment: <base64url>  ->  201 with the bundle
```

```json
{
  "error": { "code": "PAYMENT_REQUIRED", "message": "pay for this bundle, then retry" },
  "payment": {
    "amount": "1.00", "asset": "ANYONE", "chain": "sepolia",
    "recipient": "0x...", "route_id": "route-1", "nonce": "..."
  }
}
```

The buyer settles and retries the identical request with `X-Payment` carrying a base64url receipt
`{payer, tx_hash, amount, route_id, nonce}`. Your proxy verifies settlement and mints the
`X-Payment-Claim` above.

The harness retries **at most once**: a proxy that answers 402 to an already-paid request is broken,
and looping there would mean paying repeatedly. Only `payment.amount` is required; unknown fields
are passed through untouched, so you can add fields without waiting on a harness release.

## What we return, and what we reject

`POST /v1/bundles` takes `{epoch, blinded_blanks[]}` and returns
`{epoch, blind_signatures[]}` — exactly `k` blobs, 256 bytes each for RSA-2048. An optional
`Idempotency-Key` header makes the call safe to retry.

| Code | Status | Cause |
| ---- | ------ | ----- |
| `CLAIM_INVALID` | 402 | Claim missing, malformed, badly signed, or wrong amount. |
| `BUNDLE_SIZE` | 400 | Not exactly `k` blanks. |
| `BLANK_FORMAT` | 400 | A blank is not base64, is the wrong size, or is not a valid blinded message. |
| `REQUEST_INVALID` | 400 | Body is not an object, or `epoch` is missing. |
| `IDEMPOTENCY_CONFLICT` | 409 | `Idempotency-Key` reused with a different body. |
| `RATE_LIMITED` | 429 | Too many requests for this `payment_ref`. |

A `402` carrying a `payment` block is a payment demand. A `402` without one is us rejecting your
claim — the body says which.

Blanks are measured and discarded. The issuer never parses, logs or stores blank or signature bytes
beyond validating count and length, and never sees an unblinded serial.

## Knobs, if signing gets in your way

| Variable | Effect |
| -------- | ------ |
| `SIGNING_WORKERS=0` | Signs inline, starts no worker threads at all. Slower, simplest to run. |
| `SIGNING_NATIVE_RSA=false` | Forces the library's pure-JS path. Slow: pair with workers, not with `0`. |
| `BUNDLE_SIZE`, `BUNDLE_PRICE` | `k` and the price your claims must match. |

All modes produce identical signatures. Nothing about issuance performance should block you; worst
case, turn all of it off and you still get correct credentials.

## What we need from you

Ask these once the runtime above makes sense; they are easier to answer having seen it.

1. **Is `payment_ref` single-use?** May one `payment_ref` buy more than one bundle? Today nothing
   stops a captured claim being replayed for another bundle, and each one counts as paid. If refs
   are one per purchase, we can enforce single-use cheaply, since we already record every one. This
   is the most important question on the list.
2. **Should `proxy_sig` bind the request body?** It currently covers the three claim fields only, so
   a captured claim can be re-pointed at a different set of blanks. Binding a digest of
   `blinded_blanks` closes that, at the cost of your proxy hashing a payload it otherwise ignores.
3. **Should the claim carry its own expiry?** There is no timestamp or nonce in it today, so a
   leaked claim stays valid indefinitely.
4. **Is `X-Payment` and a `{payer, tx_hash, ...}` receipt the right shape**, and does the `nonce`
   need signing so you can tell a replayed receipt from a fresh one?
5. **Decimal string or integer base units for `amount`?** Exact decimals work and are implemented,
   but base units would be less ambiguous.
6. **How should we receive and rotate your public key?** It is a mounted file today.
7. **Confirm the error codes above** read sensibly from your side. `REQUEST_INVALID` and
   `IDEMPOTENCY_CONFLICT` are ours, not the spec's.

Everything in this document is implemented and testable now, but the format is **not agreed**.
Changing it is cheap today and expensive once your proxy ships against it.
