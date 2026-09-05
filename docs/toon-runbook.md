# TOON integration runbook

Get a real issuer running in a few minutes, drive a purchase through it, then read the two
interfaces your proxy has to implement. Nothing here needs a build: the image comes from the
registry.

The issuer sits **behind** your proxy. The buyer never talks to it directly, and it never talks to
a chain. Your proxy takes payment and vouches for it; the issuer trusts that voucher and signs.

```
buyer  ->  TOON proxy  ->  issuer
           collects payment  verifies X-Payment-Claim
           mints the claim   blind-signs k blanks
```

The buyer pays as part of the request. There is no 402 exchange: they came to buy a bundle at a
price they already know, so there is nothing to discover.

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

`bun run keys:dev` stands in for keys that are yours and ours respectively in a real
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

## Interface 2: the 402 pay-and-retry flow, withdrawn

This runbook originally proposed that the proxy answer an unpaid `POST /v1/bundles` with a `402`
carrying a price, and that the buyer settle and retry with an `X-Payment` receipt.

**That model does not fit what is being sold.** Pay-and-retry is discovery: a caller tries a
resource, learns it costs money, and decides. A credential buyer is not discovering anything. They
came to buy a bundle, at a price they already know, and the round trip only adds a rejection before
the purchase they always intended to make.

[anytoon](https://github.com/toon-protocol/anytoon) does the right thing instead: payment is
collected over ILP in the connector, as part of the request, and the issuer sees a paid request or
no request at all. Nothing needs a 402 exchange.

Kept here only because our buyer harness still drives the withdrawn flow (`--payment stub-receipt`),
which is why it cannot drive a TOON stack. That is ours to clean up.

**The issuer's own 402s are a different thing and are real.** They mean "this claim is not good",
never "here is a price": the issuer has no price to quote and never asks anyone to pay. See the
error table below.

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
| `WRONG_EPOCH` | 400 | The named epoch is past its grace window, or unknown. |

Every `402` from the issuer is a rejected claim, never a payment demand: it has no price to quote
and never asks anyone to pay. The body says which rejection.

Blanks are measured and discarded. The issuer never parses, logs or stores blank or signature bytes
beyond validating count and length, and never sees an unblinded serial.

## Knobs, if signing gets in your way

| Variable | Effect |
| -------- | ------ |
| `SIGNING_WORKERS=0` | Signs inline, starts no worker threads at all. Slower, simplest to run. |
| `SIGNING_NATIVE_RSA=false` | Forces the library's pure-JS path. Slow: pair with workers, not with `0`. |
| `BUNDLE_SIZE`, `BUNDLE_PRICE` | `k` and the price your claims must match. |

Epochs rotate. `GET /v1/keys/current` tells you the current one, and a bundle must name an epoch
that is still usable or you get `WRONG_EPOCH`. A rotated-out epoch keeps signing for a grace window,
so a buyer who read the key document moments before a rotation is not stranded mid-purchase.

All modes produce identical signatures. Nothing about issuance performance should block you; worst
case, turn all of it off and you still get correct credentials.

## Breaking change since this runbook was written

**M1.2 replaced `KEY_DOCUMENT_PATH` and `ISSUER_PRIVATE_KEY_PATH` with a single `KEYRING_PATH`**,
pointing at a keyring that holds every usable epoch and its private key rather than one document
plus a separate PEM. The old variables are ignored, and a container started with only those fails at
boot: `unable to read keyring at config/keys/keyring.json`.

That landed one commit after this runbook, and `ghcr.io/anyone-protocol/credentials-issuer:latest`
moved with it. If you configured against the earlier `compose.published.yml`, pull and you will see
the boot failure. The current [compose.published.yml](../compose.published.yml) has the right shape;
`bun run keys:dev` generates the keyring.

**Pin a SHA tag rather than `latest`.** Every push publishes `type=sha` as well, and pinning means an
upstream change lands when you choose rather than on your next pull. This is on us: the rename
should have come with a note here, and did not.

## What we need from you

Some of these are answered now that [anytoon](https://github.com/toon-protocol/anytoon) exists.

1. ~~**Is `payment_ref` single-use?**~~ **Answered: no, and it must not be.** It is the paying
   channel identity, stable per payer, so that rate limits follow the payer and idempotent retries
   match ([anytoon ADR 0002](https://github.com/toon-protocol/anytoon/blob/master/docs/adr/0002-payment-reference-is-the-paying-channel-identity.md)).
   Enforcing single-use would break both. The replay gap is real but has to be closed another way.

2. **Nonce and expiry, or binding to the request body?** Both close the replay gap, and you have
   proposed the first. A nonce plus expiry, with the issuer recording spent nonces for the window,
   is the smaller change for you; binding a digest of `blinded_blanks` into `proxy_sig` costs your
   minter a hash of a payload it otherwise ignores but ties a claim to exactly what it paid for.
   **Ours to decide, and still open.** See [payment-claim.md](payment-claim.md).

3. ~~**Is `X-Payment` and a `{payer, tx_hash, ...}` receipt the right shape?**~~ **Withdrawn.**
   Pay-and-retry is a discovery flow, and nobody buying credentials is discovering a price. Paying
   as part of the request, as your connector does, is the right shape. Our harness still drives the
   old flow and needs to catch up; the M0.3 scenario is worded around it too.

4. **Decimal string or integer base units for `amount`?** Still open. Your `connector.toml` prices
   in base units and signs a decimal, which is exactly the conversion that would disappear if the
   claim carried base units. Against that, decimals are implemented and working on both sides.

5. ~~**How should we receive and rotate your public key?**~~ **Answered in practice:** a mounted
   file, same as ours. Worth revisiting only when rotating it matters.

6. **Confirm the error codes** read sensibly from your side. `REQUEST_INVALID` and
   `IDEMPOTENCY_CONFLICT` are ours, not the spec's.

7. **Which price wins?** You configure `0.01`; this repo defaults to `1.00`. They must match exactly
   or every paid request returns `CLAIM_INVALID`. One of us has to move, and it is probably us.

Everything in this document is implemented and testable now. The claim wire format is settled and
byte-identical on both sides; the rest of it is not agreed, and changing it is cheap today and
expensive once more is built against it.
