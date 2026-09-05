# Deploying the issuer (M0.3)

Three Nomad jobs in [operations/](../operations/), one per concern, all in the `stage-services`
namespace on the `ator-fin` datacenter:

| Job | What it is |
| --- | ---------- |
| `credentials-issuer-postgres-stage` | Postgres 18, on a host volume. The aggregates and the entitlement store. |
| `credentials-issuer-redis-stage` | Redis 7, deliberately ephemeral. Rate-limit windows and the reconciliation schedule. |
| `credentials-issuer-stage` | The issuer. A prestart task runs migrations, then the service starts. |
| `credentials-issuer-rotate-epoch-stage` | Weekly periodic batch. Rotates the epoch keyring in Vault. |

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
| `KEYRING_BASE64` | The epoch keyring, base64 of the JSON file. Contains **private** epoch keys. Written by the rotation job. |
| `PROXY_PUBLIC_KEY_BASE64` | The TOON proxy's Ed25519 public key, base64 of the SPKI PEM. |

**Vault, `kv/stage-services/credentials-issuer-rotation-stage`** — a separate path, readable only by
the rotation job:

| Key | Value |
| --- | ----- |
| `ROOT_KEY_BASE64` | The issuer root private key, base64 of the PKCS#8 PEM. The issuer must not be able to read this. |
| `VAULT_ADDR` | The address the rotation job writes `KEYRING_BASE64` back to. |

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

Rotation by hand is the same tool against the same file, followed by re-writing `KEYRING_BASE64`:

```sh
bun run rotate-epoch --keyring config/keys/keyring.json --root-key config/keys/root.pem
```

In the cluster the periodic job does it against Vault directly, which is a read-modify-write on one
field guarded by a compare-and-set, so it preserves the database credentials sharing the path and
fails rather than clobbering a rotation that landed first.

## Rotation, and why it is not optional

**Nothing rotates the keyring by itself outside the cluster.** Left alone, the current epoch reaches
its `not_after`, the issuer keeps serving a key document nobody can buy against, every purchase
returns `WRONG_EPOCH`, and the service otherwise looks fine. `GET /healthz` is what catches this: it
returns **503** once the advertised epoch has expired, and reports `expires_in_seconds` while it has
not, so a check can alarm before issuance stops. The issuer also logs a warning on every keyring
reload inside the last day.

A failing health check will make Nomad restart and eventually reschedule the alloc, which does not
fix an expired keyring. That is intended: the job going red is the alarm, and a rotation is the fix.

`credentials-issuer-rotate-epoch-stage` runs `@weekly` with `prohibit_overlap`. Two parameters are
worth understanding:

- **The cron period is the effective epoch length**, and therefore the anonymity set every credential
  issued during it belongs to. This is decision 2 in
  [credential-parameters.md](credential-parameters.md); the weekly default is a placeholder.
- **`--epoch-seconds` is a ceiling, not the period.** Four weeks against a weekly cron means three
  weeks of tolerance for a broken rotation job before issuance actually stops.

The rotation job needs its own Vault path, `kv/stage-services/credentials-issuer-rotation-stage`,
holding `ROOT_KEY_BASE64` and `VAULT_ADDR`. **Its policy must be separate from the issuer's.** The
issuer never holding the root key is the reason a compromised issuer can abuse the current epoch key
but cannot mint epochs or forge a key document, and that invariant is a Vault policy, not something
this repo can enforce.

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

The scenario is a buyer paying for a bundle through the TOON connector and receiving `k` blobs that
verify under the published epoch key. **We cannot drive it from here.** Payment is collected over ILP
inside the connector, and minting a claim needs the proxy's signing key, which the issuer only ever
holds the public half of. The buyer that drives it is
[anytoon's](https://github.com/toon-protocol/anytoon) -- `make buy`, or `make local-e2e` for the whole
loop on a local chain.

Our buyer harness still speaks the withdrawn 402 pay-and-retry flow, so it cannot drive a TOON stack;
see [toon-runbook.md](toon-runbook.md).

What we *can* run against a deployment, and should after every deploy:

```sh
bun run harness --url <issuer url> --keys-only
```

It checks the key document an unpaying caller can reach -- fields, suite, validity window -- and
exits nonzero naming what failed. The CI workflow does the same when dispatched with a
`conformance_url`. Pair it with `GET /healthz`, which returns 503 once no epoch key can sign.

### Rehearsing a purchase without TOON

The withdrawn flow can still be stood up locally, which exercises real blind signing end to end even
though nobody will deploy it:

```sh
bun run fake-proxy --issuer <issuer url> --port 3110   # settles nothing, accepts any receipt
bun run harness --url http://localhost:3110 --payment stub-receipt
```

This proves issuance, not conformance: the scenario is met only against the real connector.

## Configuration

Every knob is in the [README's configuration table](../README.md#configuration). The jobspec sets
them as environment variables; the ones worth a second look on a deploy:

- `SIGNING_WORKERS` sizes the blind-signing thread pool. It should track the cores the alloc
  actually gets, not the host's. `0` signs inline and starts no threads.
- `BUNDLE_SIZE`, `BLANK_SIZE_BYTES` and `SIGNATURE_SIZE_BYTES` are provisional until the 0.3
  credential spec lands, and must match what the buyer harness and TOON expect.
- `BUNDLE_PRICE` must match the amount the proxy puts in its claim, or every purchase is
  `CLAIM_INVALID`.
