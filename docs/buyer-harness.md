# Buyer harness

A headless buyer for the credential issuer: it reads the key document, blinds `k` blanks, buys a
bundle, and judges the response against the issuer contract. It is a library first and a CLI
second, because it has three jobs beyond its own tests: TOON's conformance tool against any issuer
deployment, the seed of the future Anyone agent SDK, and the thing that proves a buy end to end in
the sandbox.

Lives in [packages/buyer-harness](../packages/buyer-harness/). It declares the wire format itself
rather than importing it from the issuer, so it can judge an issuer it did not ship with.

## CLI

```sh
bun run harness --url http://localhost:3000
```

```
✓ key document fields: epoch 0
✓ key document suite: RSABSSA-SHA384-PSS-Randomized
✓ key document validity window: 2026-01-01T00:00:00.000Z to 2027-01-01T00:00:00.000Z
✓ bundle count: 10 blobs, as configured
✓ signature size: all 10 blobs are 256 bytes
✓ epoch echoed: epoch 0
```

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--url` | required | Issuer base URL. |
| `--bundle-size` | `10` | `k`. Provisional until the 0.3 spec lands. |
| `--blank-size` | `256` | Blinded blank size in bytes. |
| `--signature-size` | `256` | Expected blob size in bytes. |
| `--epoch` | issuer's current | Epoch to request. |
| `--payment-ref` | random | Payment reference to claim. |
| `--idempotency-key` | none | Sends an `Idempotency-Key` header. |
| `--json` | off | Emit the report as JSON for machine consumption. |

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Conforming. |
| `1` | Nonconforming. Failed check names are printed to stderr. |
| `2` | Unusable: bad flags, or the issuer was unreachable or returned an error status. |

`1` and `2` are kept distinct so CI can tell "the issuer is wrong" from "the run never happened".

## Library

```ts
import { purchaseBundle } from '@anyone-protocol/buyer-harness';

const { response, conformance } = await purchaseBundle({
  baseUrl: 'http://localhost:3000',
  paymentRef: 'pay-1',
});

if (!conformance.passed) { /* conformance.checks carries name, passed, detail */ }
```

`IssuerClient` is available directly for callers that want the endpoints without the judging, and
every check is exported (`checkBundle`, `checkKeyDocument`) for callers assembling their own report.

## Checks

| Check | Asserts |
| ----- | ------- |
| `key document fields` | `epoch_id`, `not_before`, `not_after`, `alg`, `pubkey` all present. |
| `key document suite` | `alg` is `RSABSSA-SHA384-PSS-Randomized` (I1). |
| `key document validity window` | `not_before` precedes `not_after`. |
| `bundle count` | Exactly `k` blobs (I3). |
| `signature size` | Every blob is valid base64 decoding to exactly the expected size. |
| `epoch echoed` | The response echoes the requested epoch. |
| `signature verifies` | Every blob unblinds to a signature that verifies under the epoch public key (M1.1). |

## Blinding

`RsaBlinder` in [blinding.ts](../packages/buyer-harness/src/blinding.ts) implements RFC 9474
Prepare/Blind/Finalize over `@cloudflare/blindrsa-ts`, suite `RSABSSA-SHA384-PSS-Randomized`. The
serial is fresh random bytes chosen by the buyer; the issuer only ever sees the blinded form (I2).

`prepare()` returns the blinded blanks to send plus the state needed to unblind, so `finalize()` can
turn the issuer's blind signatures into credentials and `verify()` can check each one under the
epoch public key. Supply your own `Blinder` through `purchaseBundle({ blinder })` to drive the flow
differently.

Note that correctly sized random bytes are **not** valid blinded blanks: RFC 9474 requires the
blinded message to be less than the RSA modulus, so an issuer signing for real rejects roughly a
quarter of random ones with `BLANK_FORMAT`.

## Not yet built

Deterministic test vectors for wallet interop (M1.1) are still outstanding. `blind()` draws its
blind factor from an internal RNG with no injection point, so RFC 9474 FixedBlind vectors are not
reachable through the library's public API. Resolving that is a prerequisite, not a detail.
