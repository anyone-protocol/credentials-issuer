# Deploying the issuer (M0.3)

Three Nomad jobs in [operations/](../operations/), one per concern, all in the `stage-services`
namespace on the `ator-fin` datacenter:

| Job | What it is |
| --- | ---------- |
| `credentials-issuer-postgres-stage` | Postgres 18, on a host volume. The aggregates and the entitlement store. |
| `credentials-issuer-redis-stage` | Redis 7, deliberately ephemeral. Rate-limit windows and the reconciliation schedule. |
| `credentials-issuer-stage` | The issuer. A prestart task runs migrations, then the service starts. |

Backing stores first, then the issuer: the issuer's templates block until both register in Consul.

Only a stage jobspec exists. There is no live one on purpose, and there should not be until the
[known holes](../README.md#status) are closed: a captured payment claim can be replayed for more
bundles, and receipt validation accepts any string.

## Prerequisites

**Host volume.** A client host volume named `credentials-issuer-postgres-stage` on a `stage` pool
client. Nothing else needs storage; Redis holds no source of truth, which is why it has no volume.

**Vault, `kv/stage-services/credentials-issuer-postgres-stage`:**

| Key | Value |
| --- | ----- |
| `DB_USER`, `DB_PASS` | Postgres superuser credentials the container initializes with. |

**Vault, `kv/stage-services/credentials-issuer-stage`:**

| Key | Value |
| --- | ----- |
| `DB_USER`, `DB_PASS` | The same credentials; the issuer connects with them. |
| `KEYRING_BASE64` | The epoch keyring, base64 of the JSON file. Contains **private** epoch keys. |
| `PROXY_PUBLIC_KEY_BASE64` | The TOON proxy's Ed25519 public key, base64 of the SPKI PEM. |

**GitHub secrets**, for the manual deploy job: `NOMAD_ADDR` and
`NOMAD_TOKEN_CREDENTIALS_ISSUER_DEPLOY`. The Nomad CA is committed at
[operations/admin-ui-ca.crt](../operations/admin-ui-ca.crt).

## Seeding the keyring

The issuer never holds the root private key, so the keyring is built outside the cluster and put
into Vault. Generate it on an operator machine, not in CI:

```sh
bun run keys:dev                      # a root key, a one-epoch keyring, a stand-in proxy key
base64 -w0 config/keys/keyring.json   # -> KEYRING_BASE64
```

For a real sandbox, replace the stand-in proxy key with TOON's actual public key, and keep
`config/keys/root.pem` somewhere the cluster cannot reach. Losing it means no further rotations;
leaking it means anyone can mint epoch documents the issuer will trust.

Rotation is the same tool against the same file, followed by re-writing `KEYRING_BASE64`:

```sh
bun run rotate-epoch --keyring config/keys/keyring.json --root-key config/keys/root.pem
```

The keyring template is `change_mode = "noop"` because the issuer re-reads the file every
`KEYRING_RELOAD_SECONDS`. A rotation therefore lands without restarting anything, and the outgoing
epoch keeps signing until its grace window closes. The proxy public key is `change_mode = "restart"`
instead: it is read once at boot.

## Deploying

Deploying is manual. A push to `master` publishes a SHA-tagged image and stops there, so merging
never moves the sandbox by itself.

- **From CI:** run the CI workflow with `deploy` ticked. It runs the stage jobspec against the SHA
  that was just built.
- **By hand:** `nomad job run -var="commit_sha=<sha>" operations/credentials-issuer-stage.hcl`.
  Without `-var`, the jobspec's pinned default decides, which is what you want for a redeploy of
  the current build and not what you want when promoting a new one.

The image is at `ghcr.io/anyone-protocol/credentials-issuer`. Images built before the 2026-09-04
rename are at the old `credential-issuer` path and were not copied over.

## The M0.3 conformance run

The scenario is the buyer harness driving `request -> 402 -> pay $ANYONE -> retry` against the
deployed issuer behind the TOON proxy, and receiving exactly `k` blobs of the configured size:

```sh
bun run harness --url <TOON proxy url> --payment stub-receipt
```

Or run the CI workflow with `conformance_url` set to the proxy URL. It exits nonzero naming the
assertion that failed, so it is usable as a smoke test after every deploy.

Point it at the **proxy**, not the issuer: `stub-receipt` expects the 402. Against a bare issuer
use `--payment stub-claim --proxy-key <path>` instead, which skips the payment flow and signs a
claim directly.

### Rehearsing it without TOON

The 402 half can be stood up locally, so the deployed artifact can be exercised before the proxy
route exists:

```sh
bun run fake-proxy --issuer <issuer url> --port 3110   # settles nothing, accepts any receipt
bun run harness --url http://localhost:3110 --payment stub-receipt
```

This proves everything except on-chain settlement and TOON's own claim minting. It is a rehearsal,
not the scenario: the scenario is only met against the real proxy on Sepolia.

## Configuration

Every knob is in the [README's configuration table](../README.md#configuration). The jobspec sets
them as environment variables; the ones worth a second look on a deploy:

- `SIGNING_WORKERS` sizes the blind-signing thread pool. It should track the cores the alloc
  actually gets, not the host's. `0` signs inline and starts no threads.
- `BUNDLE_SIZE`, `BLANK_SIZE_BYTES` and `SIGNATURE_SIZE_BYTES` are provisional until the 0.3
  credential spec lands, and must match what the buyer harness and TOON expect.
- `BUNDLE_PRICE` must match the amount the proxy puts in its claim, or every purchase is
  `CLAIM_INVALID`.
