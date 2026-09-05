# Issuer Service MVP — Scope & Deliverables

**Repo:** `credentials-issuer` · **Status:** Ready to build · **Built & operated by:** Anyone (Memetic Block eng) · **Consumed by:** TOON proxy (fronting), buyer clients/scripts, later the Anyone client wallet
**Context:** Seeds the Sepolia integration sandbox. M0 unblocks TOON's connector/proxy/payout work immediately; M1 makes issuance real; M2 is internal-only and can lag.

## Invariants (agents: violating one of these fails the ticket, full stop)

- I1 **No hand-rolled crypto.** Blind signatures come from `@cloudflare/blindrsa-ts` (RFC 9474 compliant, ships RFC test vectors). Suite: **RSABSSA-SHA384-PSS-Randomized**. No custom implementations, no "optimizations" of library internals. *Amended 2026-09-04:* supplying a missing **platform primitive** is permitted where the library already has a documented path for it (WebCrypto `RSA-RAW`, via the public `supportsRSARAW` parameter), provided every protocol step still runs inside the library, the primitive is backed by a vetted implementation rather than written here, and it is gated on a known-answer test against an independent RFC 9474 implementation. Reimplementing any protocol step remains forbidden. See the README for the reasoning and the guards.
- I2 **The issuer never sees an unblinded serial.** Requests carry blinded blanks; responses carry blind signatures. Any code path that logs, stores, or parses blank/signature payload bytes beyond size/count validation is a bug.
- I3 **One denomination, fixed bundles.** `POST /v1/bundles` issues exactly `k` credentials per call at one price. No variable amounts, no credential types, no country typing.
- I4 **Epoch keys only.** All signing under the current epoch key; key doc published at `GET /v1/keys/current` (static file in MVP, simulating consensus pinning — format must match the 0.3 spec's consensus-publication schema).
- I5 **Minimal retention.** Persist aggregates and payment references only. No request bodies, no IPs, no per-purchase detail beyond `{payment_ref, epoch, bundle_count, timestamp}`.
- I6 **Paid credentials only.** No free class exists anywhere in this service.

## Working method (BDD)

The Gherkin scenarios below are the **definition of done and the spec of record** — implement until green in CI. If a needed behavior isn't captured by a scenario, raise it as a question; never add or alter scenarios unilaterally. Parameters (`k`, blob sizes, epoch length) stay symbolic here and bind in config when the 0.3 spec lands. Negative paths live with the ticket that owns the behavior.

## Stack (match existing infra)

TypeScript / NestJS on the **Bun** runtime (repo decision, not in the original stack line) · PostgreSQL (aggregates, entitlements) · Vault (epoch private keys; transit or KV+app-level, decide in M1.2) · Docker image + Nomad job · plain HTTPS in the sandbox (onion-service fronting is a later deployment phase, not this scope).

## M0 — Stub issuer (target: days; unblocks TOON)

**M0.1 API skeleton.** `POST /v1/bundles` accepting `{epoch, blinded_blanks[]}`; `GET /v1/keys/current` serving the static key doc; `GET /healthz`. Dummy blobs sized exactly as real RSABSSA-SHA384 blind signatures will be (256 bytes for RSA-2048; from config).

```gherkin
Scenario: bundle purchase returns correctly sized blobs
  Given a valid epoch and a payment claim forwarded by the proxy
  When the client POSTs k correctly sized blinded blanks to /v1/bundles
  Then the response contains exactly k blobs of the configured signature size
  And nothing beyond {payment_ref, epoch, bundle_count, timestamp} is persisted

Scenario: over-count bundle is rejected
  Given a valid payment claim
  When the client POSTs k+1 blinded blanks
  Then the issuer responds with a typed BUNDLE_SIZE error and signs nothing

Scenario: malformed blank is rejected
  Given a valid payment claim
  When any blinded blank has a byte length other than the configured blank size
  Then the issuer responds with a typed BLANK_FORMAT error and signs nothing

Scenario: key document is served
  Given a configured static key document
  When the client GETs /v1/keys/current
  Then the response matches the 0.3 consensus-publication schema
  And includes epoch_id, validity window, alg, and pubkey
```

**M0.2 Request hygiene.** Idempotency keys; typed errors; rate limiting keyed by payment_ref, never by IP (I5).

```gherkin
Scenario: replayed idempotency key does not double-issue
  Given a completed purchase with idempotency key K
  When the same request is resubmitted with key K
  Then the original response is returned unchanged
  And issuance counters are not incremented

Scenario: rate limit is per payment_ref
  Given requests exceeding the configured limit for one payment_ref
  When the next request arrives for that payment_ref
  Then it receives a typed RATE_LIMITED error
  And requests carrying other payment_refs are unaffected
```

**M0.3 Sandbox deployment.** Dockerfile + Nomad job, deployed behind the TOON connector route on the integration sandbox.

*Reworded 2026-09-04.* The original said "the stub", "the TOON proxy" and "request → 402 → pay $ANYONE → retry". Issuance is real since M1, the proxy role is filled by a connector plus a claim minter, and the 402 pay-and-retry flow was withdrawn: buying credentials is not a discovery flow, so payment is collected as part of the request. See docs/toon-runbook.md.

```gherkin
Scenario: end-to-end conformance through the TOON connector
  Given the issuer deployed behind the TOON connector and claim minter
  When a buyer pays for a bundle in $ANYONE and submits k blinded blanks
  Then it receives exactly k blobs of the configured size
  And every credential verifies under the published epoch key
```

**M0.4 Headless buyer harness.** Library + CLI, not a one-off script (seed of the future agent SDK; also TOON's conformance tool).

```gherkin
Scenario: harness passes against a local stub in CI
  Given a local stub issuer
  When the harness CLI executes a purchase
  Then it exits 0 having asserted blob count and size

Scenario: harness detects a nonconforming issuer
  Given a stub configured to return one blob of the wrong size
  When the harness CLI executes a purchase
  Then it exits nonzero naming the size assertion that failed
```

**M0 acceptance:** all M0 scenarios green in CI; TOON completes their proxy/connector flow end-to-end using only this doc, the running endpoint, and the harness.

## M1 — Real blind issuance

**M1.1 Library integration.** `BlindSign` server-side via `@cloudflare/blindrsa-ts`; harness upgraded to Prepare/Blind/Finalize; deterministic test vectors (FixedBlind) published in the repo for wallet interop.

```gherkin
Scenario: issued signature verifies after unblinding
  Given the current epoch keypair
  When the harness blinds a message, the issuer blind-signs it, and the harness finalizes
  Then the resulting signature verifies under the epoch public key
  And the suite used is RSABSSA-SHA384-PSS-Randomized

Scenario: published test vectors cross-verify
  Given the repo's deterministic test vectors
  When they are checked against an independent RFC 9474 implementation (CIRCL/Go)
  Then every vector passes in both directions
```

**M1.2 Epoch key lifecycle.** Per-epoch keygen in Vault; key doc `{epoch_id, not_before, not_after, alg, pubkey, root_sig}` signed by the issuer root key (placeholder for dirauth consensus signing); rotation job with a grace window.

```gherkin
Scenario: previous epoch honored during grace window
  Given epoch e has just rotated to e+1
  When a request carries epoch e blanks within the grace window
  Then it is signed under the epoch e key

Scenario: expired epoch rejected after grace
  Given the grace window for epoch e has elapsed
  When a request carries epoch e blanks
  Then the issuer responds with a typed WRONG_EPOCH error and signs nothing

Scenario: rotated key document is integrity-protected
  Given a completed rotation to epoch e+1
  When the client GETs /v1/keys/current
  Then the document describes epoch e+1
  And its root_sig verifies under the issuer root public key
```

**M1.3 Aggregate accounting.** Per-epoch counters (bundles_paid, signatures_issued); reconciliation job; divergence alarm — overissuance is theft from the redemption pool; the alarm is the point of the table.

```gherkin
Scenario: reconciliation is exact over a scripted run
  Given a scripted run of 1000 successful purchases in one epoch
  When the reconciliation job runs
  Then signatures_issued equals bundles_paid × k
  And no alarm is raised

Scenario: overissuance raises an alarm within one cycle
  Given signatures_issued incremented without a matching payment (fault injection)
  When the next reconciliation cycle runs
  Then the overissuance alarm fires identifying the epoch and delta
```

**M1.4 Payment-claim interface.** Issuer trusts the fronting proxy's forwarded proof-of-payment: `{payment_ref, amount, route_id, proxy_sig}`. **The one interface requiring TOON agreement — settle the format during M0.**

```gherkin
Scenario: valid proxy claim admits issuance
  Given a claim whose proxy_sig verifies and whose amount matches the bundle price
  When the purchase request is processed
  Then issuance proceeds and bundles_paid is incremented once

Scenario: invalid claim is rejected without signing
  Given a claim with a bad proxy_sig or mismatched amount
  When the purchase request is processed
  Then the issuer responds with a typed CLAIM_INVALID error
  And nothing is signed and a rejection counter is incremented
```

**M1 acceptance:** all M1 scenarios green, including cross-verification against the independent implementation; full buy→unblind→local-verify loop green in the Sepolia sandbox.

## M2 — Entitlement drip (internal, may lag M1)

**M2.1 Entitlement store + drip.** `{entitlement_id → drip schedule}`; receipt validation mocked (real App Store/Play verification out of scope).

```gherkin
Scenario: due drip issues through the standard path
  Given an entitlement whose next drip is due
  When the client presents the entitlement and blinded blanks
  Then k blobs are issued via the identical M1 signing path
  And the drip schedule advances

Scenario: early pickup is rejected
  Given an entitlement whose next drip is not yet due
  When the client requests pickup
  Then the issuer responds with a typed NOT_DUE error and signs nothing
```

**M2.2 Convergent issuance.**

```gherkin
Scenario: fiat and crypto credentials are indistinguishable
  Given one credential issued via entitlement drip and one via paid bundle
  When their wire formats are compared
  Then they are identical in size and structure with no rail-identifying field
```

## Non-goals (do not build, even if it seems helpful)

Onion-service deployment · real consensus publication · threshold issuance · redemption/payout service · anything spend-side (RELAY_TICKET, exits) · real app-store receipt validation · mainnet anything.

## Inputs needed before M1 starts

1. 0.3 credential spec: serial format, k (bundle size), RSA modulus size → blob sizes.
2. Payment-claim format agreed with TOON (M1.4).
3. TOON confirmation that their channel contracts have (or will get) a Sepolia deployment — the only rig component neither side controls yet.
