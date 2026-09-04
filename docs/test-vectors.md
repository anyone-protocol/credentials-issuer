# Test vectors

[test-vectors/rsabssa-sha384-pss-randomized.json](../test-vectors/rsabssa-sha384-pss-randomized.json)
publishes RFC 9474 vectors for suite `RSABSSA-SHA384-PSS-Randomized`, so a wallet or any other
client can check its implementation against ours without running the issuer.

Half the vectors come from `@cloudflare/blindrsa-ts` (what this repo signs with), half from
[CIRCL](https://github.com/cloudflare/circl) in Go (an independent RFC 9474 implementation). Every
vector is checked by **both** implementations in CI, which is what makes them worth trusting: a bug
shared by generator and checker would otherwise go unnoticed.

## Format

All byte fields are hex, following the style of the RFC's own vectors.

| Field | Meaning |
| ----- | ------- |
| `name`, `origin` | Identifier, and which implementation produced it. |
| `private_key_pkcs8`, `public_key_spki` | DER, hex-encoded. |
| `prepared_msg` | Output of Prepare: the message the signature is actually over. |
| `blinded_msg` | What a client sends the issuer. |
| `blind_sig` | What the issuer returns. |
| `inv` | Blind inverse, for Finalize. Present on `blindrsa-ts` vectors only. |
| `sig` | The unblinded signature, verifiable under the public key. |

**The private keys are published deliberately.** They are throwaway keys generated for these
vectors, and reproducing `blind_sig` is impossible without them. They are not an issuer's epoch
key, and nothing in this repo will ever load one.

`inv` is absent from CIRCL vectors because CIRCL's `Client.Finalize` takes an opaque `State` that
cannot be constructed from a stored inverse. That asymmetry is in the APIs, not in the vectors.

## What each side checks

| | blindrsa-ts (in `bun test`) | CIRCL (CI job `crossverify`) |
| --- | --- | --- |
| `BlindSign(sk, blinded_msg) == blind_sig` | yes | yes |
| `Verify(pk, sig, prepared_msg)` | yes | yes |
| `Finalize(pk, prepared_msg, blind_sig, inv) == sig` | yes, where `inv` is present | no, API cannot |

The TypeScript side runs `BlindSign` through the issuer's own `BlindSigner`, not the library
directly, so the vectors pin what the service actually does rather than what the library can do.

Blinding itself is never pinned: `blind()` draws a random blind factor with no injection point, so
its output cannot be reproduced. Everything downstream of a recorded `blinded_msg` is deterministic,
which is why the vectors start there.

## Regenerating

Vectors are committed and should stay stable. Regenerate only when the suite or the format changes.

```sh
bun run vectors:generate     # regenerates the blindrsa-ts vectors, preserves the CIRCL ones

# CIRCL vectors need Go 1.25; there is no need for it otherwise.
cd tools/circl-crossverify
go run . -mode generate -count 2      # then merge the output into the vectors file
go run . -mode verify -file ../../test-vectors/rsabssa-sha384-pss-randomized.json
```

Without a Go toolchain, run it in a container:

```sh
podman run --rm -v "$PWD":/w:z -w /w/tools/circl-crossverify docker.io/library/golang:1.25 \
  go run . -mode verify -file /w/test-vectors/rsabssa-sha384-pss-randomized.json
```
