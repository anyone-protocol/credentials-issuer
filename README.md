# Anyone Protocol — Credential Issuer

Blind signature credential issuer for Anyone Protocol paid exits. It sells fixed-size bundles of
blind-signed credentials: a buyer pays through the fronting proxy, POSTs `k` blinded blanks, and
gets back `k` blind signatures under the current epoch key. The issuer never sees an unblinded
serial.

Scope, milestones and the Gherkin scenarios that serve as the definition of done live in
[docs/issuer-mvp-scope.md](docs/issuer-mvp-scope.md). Read that first — the scenarios are the spec
of record, and its invariants (no hand-rolled crypto, no unblinded serials, minimal retention) are
non-negotiable.

## Status

**Code complete against the MVP scope**, M0.1 through M2. Issuance is **real**: the
issuer blind-signs under an epoch RSA key with `@cloudflare/blindrsa-ts`, the harness blinds,
unblinds and verifies, the published test vectors cross-verify against CIRCL, and the proxy's
payment claim must carry a valid `proxy_sig` and the right amount. Per-epoch counters reconcile on
a schedule and raise an alarm on divergence. Epoch keys rotate with a grace window and no restart.
Both payment rails, crypto and fiat, issue through one code path.

Still missing: **a valid claim can be replayed for more bundles** (see
[docs/payment-claim.md](docs/payment-claim.md)), and **receipt validation is a stub that accepts
anything** (see [the fiat rail](#the-fiat-rail-entitlement-drip)). Do not expose this outside the
sandbox.

| Endpoint | Milestone | State |
| -------- | --------- | ----- |
| `GET /healthz` | | live, 503 when no epoch key can sign |
| `POST /v1/bundles` | M0.1, M0.2, M1.1 | live, real RFC 9474 blind signatures |
| `GET /v1/keys/current` | M0.1, M1.2 | live, from the Vault-rendered keyring |
| `POST /v1/entitlements` | M2.1 | live, **mocked** receipt validation |
| `POST /v1/entitlements/pickup` | M2.1, M2.2 | live, same signing path as a paid bundle |

M0.3 ships its artifacts -- Nomad jobspecs, a manual deploy, and a dispatchable conformance run
(see [docs/deployment.md](docs/deployment.md)). Its one scenario is **verified by hand**: it needs a
sandbox deployed behind the TOON proxy, which no test process can stand up, so automating it would
mock the thing under test. `bun run scenarios` marks it `[-]` and counts it separately rather than
carrying a gap that will never close.

## API

### `POST /v1/bundles`

Issues exactly `k` credentials per call at one price (I3). The proxy's forwarded proof of payment
travels in the `X-Payment-Claim` header, specified in [docs/payment-claim.md](docs/payment-claim.md).

An optional `Idempotency-Key` header makes the call safe to retry. A replay returns the same
response and does not count the issuance twice; reusing a key for a *different* request is a
`409 IDEMPOTENCY_CONFLICT` rather than a silent second issuance, which would be overissuance.

```sh
curl -X POST localhost:3000/v1/bundles \
  -H "content-type: application/json" \
  -H "X-Payment-Claim: $(echo -n '{"payment_ref":"pay-1"}' | basenc --base64url -w0)" \
  -d "{\"epoch\":\"0\",\"blinded_blanks\":[ ... k base64 strings, 256 bytes each ... ]}"
```

Response is `{ "epoch": "0", "blind_signatures": [ ... k base64 strings ... ] }`.

Blanks are measured and discarded. Per invariant I2 the issuer never parses, logs or stores blank
or signature bytes beyond validating their count and length.

### `POST /v1/entitlements`

Registers a fiat subscription and returns `{entitlement_id, next_drip_at}`. The first drip is due
immediately, since the subscriber has already paid.

Registration is idempotent in the receipt: presenting the same receipt twice returns the same
entitlement. A second entitlement from one receipt would be a drip schedule nobody paid for, which
is the free class I6 forbids.

```sh
curl -X POST localhost:3000/v1/entitlements \
  -H "content-type: application/json" -d '{"receipt":"..."}'
```

### `POST /v1/entitlements/pickup`

Collects one due drip. The entitlement id travels in the `X-Entitlement` header; the body, the
response and the `Idempotency-Key` handling are **identical** to `POST /v1/bundles`. See
[the fiat rail](#the-fiat-rail-entitlement-drip).

An early pickup is a `409 NOT_DUE` and never reaches the signer.

### `GET /v1/keys/current`

Serves the static key document (I4) as `{epoch_id, not_before, not_after, alg, pubkey}`.
`root_sig` is added in M1.2 when the issuer root key exists.

At boot the issuer validates the document, loads the epoch signing key, and checks that the two
match. Publishing a pubkey that cannot verify our own signatures is worse than not starting, so a
mismatch stops startup.

## Epoch keys and rotation

Signing keys live in a **keyring** at `KEYRING_PATH`: every usable epoch, its published document,
and its private key. One file, because a Nomad template renders one file atomically; split across
several, a rotation could be seen half-applied.

The issuer re-reads it every `KEYRING_RELOAD_SECONDS` and swaps the keys in place, so **rotation
needs no restart**. Deploy it with `change_mode = "noop"` on the template stanza. Keeping Vault
behind a file this way means no Vault client in the service, tests that use plain files, and
issuance that survives Vault being unreachable, since the last render is on disk.

Reload is eventually consistent, and the grace window is exactly the tolerance that makes that
harmless: the outgoing key still signs while the new one lands.

### Grace, and WRONG_EPOCH

A rotated-out epoch stays signable until its `not_after`, which rotation moves to `now + grace`. So
the grace window lives in the keyring rather than in the issuer's configuration, and a buyer who
read the key document moments before a rotation is not stranded. Past that, a bundle naming it gets
`WRONG_EPOCH` and nothing is signed.

### Integrity

Every epoch document carries `root_sig`, an Ed25519 signature by the issuer root key, and the
issuer verifies **all** of them on load, not just the current one: an edited entry would otherwise
let a forged key sign credentials. A keyring that fails at boot stops startup; one that fails on
reload is refused and the previously loaded keys keep signing, so a bad rotation cannot take
issuance down mid-flight.

`root_sig` is a placeholder for dirauth consensus signing.

### Why Vault holds keys but does not sign

The scope leaves this open as "transit or KV+app-level, decide in M1.2". It is KV, and the reason is
a hard limit rather than a preference: **Vault's transit engine cannot perform BlindSign.**

RFC 9474 needs the raw RSA private operation on the blinded message -- `m^d mod n`, no padding, no
hashing, because the client already did the PSS encoding before blinding. Transit's sign endpoint
only offers complete signature schemes over a digest; it has no raw mode to call. So a design where
Vault holds the key and does the signing is not blocked on effort, it is blocked on a primitive that
does not exist there.

Two things would have to change to revisit it: something in the signing path that exposes a raw or
no-padding RSA operation (a PKCS#11 HSM can, transit cannot), and an answer on latency, since every
signature would become a network round trip -- `k` of them per purchase, against 12-29 ms for a
whole bundle locally.

Vault *generating* the epoch keypair is a separate and smaller question, and is compatible with what
is here: the rotation job could ask Vault for the key material instead of generating it. That only
moves where the key is born, not where it signs. If any of this is revisited, the change is
contained: the issuer's raw operation is behind `SignerPool` and nothing above it knows how signing
happens.

### Rotating

The root private key is **never** given to the issuer. Only the rotation tool holds it, so a
compromised issuer can abuse the current epoch key but cannot mint epochs or forge a key document.

```sh
bun run keys:dev            # dev: root key, a one-epoch keyring, and a stand-in proxy key
bun run rotate-epoch        # advance the epoch, retiring the previous one into its grace window
  --keyring config/keys/keyring.json --root-key config/keys/root.pem
  --epoch-seconds 2592000 --grace-seconds 86400
```

Rotation runs by hand against a file, or `--vault-secret <mount/path>` against Vault directly, which
is what the weekly `credentials-issuer-rotate-epoch-stage` job does. Vault mode is a
read-modify-write on one field with a compare-and-set, so it preserves the other secrets at that
path and fails rather than clobbering a rotation that landed first.

It is a separate tool rather than a job inside the issuer because the issuer's Vault policy stays
read-only: only the rotation job can reach the root key, so a compromised issuer can abuse the
current epoch key but cannot mint epochs.

**Nothing rotates by itself outside the cluster, and expiry is silent.** Left alone, the current
epoch reaches its `not_after` and the issuer keeps serving a key document nobody can buy against
while every purchase returns `WRONG_EPOCH`. `GET /healthz` returns **503** once that happens, and
reports `expires_in_seconds` while it has not, so a check can alarm before issuance stops. See
[docs/deployment.md](docs/deployment.md).

Nothing here is committed: `config/keys/` is gitignored as a whole directory, and the tests
regenerate it on a fresh clone. These are throwaway keys for local runs and are never a deployment
input; stage and live get theirs from Vault, generated by an operator (see
[docs/deployment.md](docs/deployment.md)).

One dev keyring did reach the public history before the ignore rule covered the renamed file. It
cost nothing — a test key, no deployment, and the root key was never committed — but it is why the
rule now names the directory rather than a list of filenames, which is the part that would have
mattered for a real key.

## Buyer harness

A headless buyer and conformance tool, shipped as a library plus CLI in
[packages/buyer-harness](packages/buyer-harness/). TOON can point it at any issuer deployment to
check it against the contract; it is also the seed of the future agent SDK.

```sh
bun run harness --url http://localhost:3000
```

It also drives the full `request -> 402 -> pay -> retry` flow through a fronting proxy
(`--payment stub-receipt`), with the payment itself stubbed until the channel contracts are on
Sepolia. It exits `0` conforming, `1` nonconforming (naming the failed checks), and `2` when the run
could not happen at all. Full flag list, library API and the M1.1 upgrade path are in
[docs/buyer-harness.md](docs/buyer-harness.md).

## Configuration

`k`, the blob sizes and the epoch length are **placeholders**, not decisions. There is no external
spec to wait for; they are five open questions written up in
[docs/credential-parameters.md](docs/credential-parameters.md), each with what depends on it and
what it costs to change once someone has built against it.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `BUNDLE_SIZE` | `10` | `k`, credentials per bundle. Placeholder pending 0.3. |
| `BLANK_SIZE_BYTES` | `256` | Expected decoded size of each blinded blank (RSA-2048). |
| `SIGNATURE_SIZE_BYTES` | `256` | Size of each returned blob (RSA-2048). |
| `KEYRING_PATH` | `config/keys/keyring.json` | Epoch keyring, rendered from Vault. |
| `KEYRING_RELOAD_SECONDS` | `30` | How often the keyring is re-read for rotations. |
| `PROXY_PUBLIC_KEY_PATH` | `config/keys/proxy.pub.pem` | Proxy's Ed25519 public key, SPKI PEM. |
| `BUNDLE_PRICE` | `1.00` | Price of one bundle, exact decimal. |
| `RECONCILIATION_INTERVAL_SECONDS` | `60` | How often the reconciliation cycle runs. |
| `SIGNING_WORKERS` | `4` | Blind-signing worker threads. `0` signs inline, starting no threads. |
| `SIGNING_NATIVE_RSA` | `true` | Use the RSA-RAW fast path. `false` forces the pure-JS path. |
| `SIGNING_TIMEOUT_MS` | `10000` | Bounds one signing task. Raise it if forcing the pure-JS path. |
| `ENTITLEMENT_DRIP_INTERVAL_SECONDS` | `86400` | How often a fiat entitlement becomes due for one bundle. |
| `RATE_LIMIT_MAX` | `60` | Requests per sliding window, per `payment_ref`. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Sliding window length. |

The limiter is a sliding window in Redis, so the budget cannot be spent twice back to back across a
wall-clock seam, and a blocked request still occupies a slot: hammering extends the block rather
than resetting it.

## Stack

- **Runtime** — [Bun](https://bun.sh). The service runs its TypeScript sources directly; there is no
  compile step. (The scope doc says "TypeScript / NestJS" without naming a runtime; Bun is the
  choice for this repo.)
- **Framework** — NestJS 11.
- **Postgres** via TypeORM — aggregates and entitlements. Per invariant I5 this holds counters and
  payment references only: never request bodies, IPs, or per-purchase detail beyond
  `{payment_ref, epoch, bundle_count, timestamp}`.
- **Redis** via BullMQ — background jobs (epoch rotation, reconciliation).
- **Blind signatures** — `@cloudflare/blindrsa-ts`, suite `RSABSSA-SHA384-PSS-Randomized`.
  Invariant I1 forbids any hand-rolled alternative, so the library makes every ruling, including
  whether a blinded blank is valid.
- **Deployment** — Docker image on Nomad. Vault holds the epoch private keys.

## Local development

Requires Bun and a container runtime for Redis/Postgres. This host uses **Podman** locally;
deployments and CI use Docker. The compose files work with either — substitute `podman compose`
for `docker compose` below.

```sh
podman compose up -d        # redis + postgres
cp .env.example .env
bun install
bun run keys:dev            # throwaway epoch keypair, gitignored
bun run dev                 # NestJS with watch on :3000
```

```sh
curl localhost:3000/healthz
```

Run the tests with `bun test` and the typecheck with `bunx tsc --noEmit`. The scenario tests boot
the real app against Postgres and Redis, so bring the backing services up first. CI provides them as service
containers.

To run the service itself in a container alongside the backing services:

```sh
podman compose -f compose.full.yml up --build
```

## Acceptance testing

The Gherkin scenarios in [docs/issuer-mvp-scope.md](docs/issuer-mvp-scope.md) are the spec of
record. Rather than run them through Cucumber, each is an ordinary `bun test` case declared with
`scenario('<name verbatim>')`, and a coverage gate keeps the two in sync. Plain fast tests,
with BDD's traceability guarantee bolted on.

[scenario-coverage.spec.ts](apps/backend/src/testing/scenario-coverage.spec.ts) fails the build on
any of:

- a scenario in an **enforced** milestone with no test,
- a `scenario()` name that does not appear in the scope doc verbatim (a rename, a typo, or a
  scenario invented in code, which the working method forbids),
- a scope doc that stops parsing into attributed scenarios, so the two checks above cannot pass
  vacuously,
- a milestone marked both enforced and manual, or exempted without a reason naming where its
  verification is written down.

Which milestones are enforced is one line, `IMPLEMENTED_MILESTONES` in
[scope-scenarios.ts](apps/backend/src/testing/scope-scenarios.ts). Flip a milestone on in the
commit that lands it. Until then its scenarios show in the report but do not block CI, so unbuilt
scope never fails the build.

**Manual milestones.** A scenario that needs something no test process can stand up -- a deployed
sandbox, a counterparty's service -- is listed in `MANUAL_MILESTONES` with the doc that says how it
is verified. Automating one would mock the thing under test, and leaving it unchecked would leave
the report carrying a gap that never closes, so the report scores it separately: `[-]`, counted as
verified by hand rather than as missing. The exemption is narrow by construction: the milestone
must exist in the scope doc, must not also be enforced, and must name a `docs/` page. M0.3 is the
only one.

```sh
bun run scenarios      # coverage by milestone; also a CI step
```

Tests that are not scope scenarios use plain `it()` and are free-form. Behavior that needs a
scenario and has none is a question for the scope owner, not a scenario to add here.

## Accounting and the overissuance alarm

Two per-epoch counters in `epoch_counter` are written by two different code paths: `bundles_paid`
by the payment side, `signatures_issued` by the signer, counted from the signatures actually
produced rather than from `k`. They are only ever compared, never derived from each other, because
reconciling two copies of the same number would catch nothing.

A BullMQ job runs every `RECONCILIATION_INTERVAL_SECONDS` and raises an alarm on any divergence:

| Alarm | Meaning |
| ----- | ------- |
| `overissuance` | More signatures issued than paid for. Theft from the redemption pool. |
| `underissuance` | Fewer. Buyers were charged and not served. |
| `ledger_mismatch` | `bundles_paid` disagrees with the `issuance_record` ledger. |

Alarms are logged at error level naming the epoch and delta, and persisted to
`reconciliation_alarm` so an operator can ask whether one has ever fired without searching logs.
The counters commit in the same transaction as the purchase, so a rolled-back purchase cannot
leave a counter behind.

`bundle_size` is recorded per epoch, so changing `k` later cannot retroactively make a settled
epoch look diverged.

## The fiat rail (entitlement drip)

M2 adds a second way to be authorized for a bundle, not a second way to issue one. A fiat
subscription buys a **drip schedule**: `{entitlement_id -> next_drip_at}`, due for exactly one
bundle each interval. When a drip is due, the pickup runs the same `IssuanceService` a paid
purchase runs, so it produces the same blind signatures under the same epoch key, writes the same
ledger row, and moves the same epoch counters. Reconciliation counts a drip as a paid bundle,
because it is one (I6).

That sharing is the point of M2.2. If the two rails had their own signing paths, fiat and crypto
credentials would form separate anonymity sets and a redeeming exit could tell which rail a
credential came from. `convergence.spec.ts` compares the two responses field by field, including
status code and media type, and verifies credentials from both rails under one public key.

**Claiming a drip is atomic.** The schedule is advanced by a conditional `UPDATE ... WHERE
next_drip_at <= now()` inside the issuance transaction, so two pickups racing for one drip issue
once: the loser re-reads a schedule that is no longer due and rolls back. Dueness is read from the
database clock, never the application's.

**Missed drips do not accumulate.** The next drip falls an interval from *now*, not from when this
one came due, so a long-idle subscriber cannot pick up a burst of bundles at once. This is settled,
not provisional: it matches how a subscription behaves, and a period you did not collect is a
period you did not use. Revisit it only if the credential is commercialized as prepaid volume
rather than as a subscription.

**A retry is not an early pickup.** A client that never saw its response can retry with the same
`Idempotency-Key` and get its credentials back rather than `NOT_DUE`; the schedule still advances
exactly once, because the issuance transaction aborts on the claimed key before the advance runs.

### What is stubbed, and what that costs

`ReceiptValidator` accepts **any non-empty string** and treats it as its own subscription id. Real
App Store / Play verification is out of scope (M2.1), so on this rail anyone can mint an
entitlement and drip credentials forever without paying. Replacing it is a prerequisite for
running the fiat rail anywhere real, sandbox included.

Entitlement ids are server-generated UUIDs rather than client-chosen, so they cannot be enumerated
into someone else's drip, but they are bearer tokens: whoever holds one collects the drips.

### Open questions for the scope author

The scenarios are the definition of done, so these were left unbuilt rather than decided here:

- **Termination.** Nothing ends an entitlement. A cancelled or refunded subscription drips
  forever, which is a free class I6 forbids. Needs an expiry on the schedule, and something
  authoritative to set it.
- **Pickup authentication.** The bare entitlement id authorizes issuance. A signed proof would
  survive a leaked id; a bearer token does not.

## Performance: the RSA-RAW fast path

`blindrsa-ts` performs the raw RSA private operation through WebCrypto's `RSA-RAW` where it exists,
and otherwise through pure-JS bignum arithmetic costing **~280ms per signature**. `RSA-RAW` is a
Cloudflare Workers extension: neither Bun nor Node has it (measured on both), because the library
targets browsers and Workers where `node:crypto` is unavailable. It is not out of date, and the
runtime choice makes no material difference.

So the issuer supplies that one primitive itself, in
[rsa-raw.ts](apps/backend/src/signing/rsa-raw.ts), backed by OpenSSL through `node:crypto`, and
constructs the suite with the library's own public `supportsRSARAW` flag. Every RFC 9474 step still
runs inside `blindrsa-ts`; the exponentiation is OpenSSL's. Signing then runs on a pool of worker
threads ([signer-pool.ts](apps/backend/src/signing/signer-pool.ts)), which keeps it off the event
loop and uses more than one core.

Measured with 8 concurrent `k=10` bundles:

| | Pure-JS, main thread | Pure-JS, 8 workers | Fast path, 4 workers |
| --- | --- | --- | --- |
| Throughput | ~3.5 sig/sec | ~27 sig/sec | **~2700 sig/sec** |
| Bundle latency | ~2.8 s | 498–3010 ms | **12–29 ms** |
| `/healthz` under load | stalls for seconds | 0.6 ms median | 0.7 ms median |

### Why this is safe, and how it is guarded

Invariant I1 was amended on 2026-09-04 to permit supplying a missing platform primitive under
conditions this meets. The risk is contained rather than assumed away:

- **It reimplements no protocol step.** Prepare, blind, blindSign, finalize and verify all stay in
  the library. `supportsRSARAW` is a public constructor parameter, not an internal.
- **It is more defensive than Cloudflare's own fast path**, which skips RFC 9474 BlindSign steps 3-4.
  This one performs that check, so a faulted exponentiation cannot leak the key.
- **Boot refuses to trust it blindly.** A known-answer test signs a CIRCL-generated vector and
  compares byte for byte. Failing it logs a warning and falls back to the pure-JS path rather than
  refusing to boot: slow issuance beats none, and the worker pool keeps it off the event loop.
- **CI cross-verifies against CIRCL in Go**, so a wrong fast path fails the build.
- **Both paths fail identically** on an invalid blank, pinned by a test.

### Single-thread mode

`SIGNING_WORKERS=0` signs inline on the main thread and starts no `worker_threads` at all. With the
fast path a `k=10` bundle is only a few milliseconds of work, so this is a perfectly usable mode and
the simplest thing to debug or run somewhere threads are awkward:

| `SIGNING_WORKERS` | Throughput | Bundle latency | `/healthz` under load |
| --- | --- | --- | --- |
| `0` (inline) | ~1000 sig/sec | 63–77 ms | 17 ms median |
| `4` (pool) | ~2600 sig/sec | 13–31 ms | 3.5 ms median |

Both modes produce identical signatures, pinned by a test: `BlindSign` is deterministic, so they are
interchangeable and you can switch without anything downstream noticing.

The one combination to avoid is `SIGNING_WORKERS=0` **with** `SIGNING_NATIVE_RSA=false`: no threads
to absorb the work and no fast path to make it cheap means seconds of blocked event loop per bundle.
Boot warns if you do it.

Otherwise set `SIGNING_NATIVE_RSA=false` to force the pure-JS path, and `SIGNING_WORKERS` to match
the deployment's CPU allocation; each worker holds its own copy of the epoch key.

The pool also has to survive its workers. Every task is bounded by
`SIGNING_TIMEOUT_MS`, and a worker that dies or misses its deadline is terminated and replaced
rather than left to swallow requests: without that, one wedged thread silently ate pool capacity
and a lost worker hung every request that reached it, forever.

**The durable fix is still upstream.** A Node/Bun backend contributed to `blindrsa-ts` would make
this polyfill unnecessary, and would work identically on either runtime.

## Database migrations

In stage/live, `synchronize` is **off** (it's only on outside production or when
`DB_SYNCHRONIZE=true`), so schema changes are applied through TypeORM migrations.

The connection is defined once in
[typeorm.config.ts](apps/backend/src/database/typeorm.config.ts) and shared by both the running app
and the migration CLI ([data-source.ts](apps/backend/src/database/data-source.ts)), so they can't
drift. Migrations live in [apps/backend/src/database/migrations/](apps/backend/src/database/migrations/).

Run these from `apps/backend` (Bun auto-loads `.env`, so they target the same database as the app):

```sh
# after changing an entity — diffs entities against the DB and writes a migration
bun run migration:generate src/database/migrations/<DescriptiveName>

# apply / roll back / inspect
bun run migration:run
bun run migration:revert
bun run migration:show
```

`migration:generate` needs the database reachable (it diffs the live schema), so have the `postgres`
service up first.

**Applying migrations on deploy.** Two options:

- **Dedicated step (recommended for multi-replica):** run `bun run migration:run` as a one-off job
  or init task before rolling out the new version, so exactly one process migrates.
- **On boot (simple, single-instance):** set `DB_MIGRATIONS_RUN=true` and the app runs pending
  migrations during startup.

The container image includes `typeorm` and the migration files, so `bun run migration:run` works
inside it.

## Docker image

The Dockerfile builds from the **repository root**:

```sh
docker build -f apps/backend/Dockerfile -t credentials-issuer .
```

Base `oven/bun:1`, runs the TypeScript sources directly, listens on `$PORT` (default 3000),
healthcheck on `/healthz`.

## CI / publishing

[.github/workflows/ci.yaml](.github/workflows/ci.yaml) runs on `ubuntu-latest`.

- Every push and pull request: `bun install`, `bunx tsc --noEmit`, `bun test`, and a separate
  `crossverify` job that checks the published test vectors against CIRCL in Go
  ([docs/test-vectors.md](docs/test-vectors.md)).
- Pushes to the default branch and `v*` tags additionally publish the image to the GitHub Container
  Registry at `ghcr.io/anyone-protocol/credentials-issuer`, tagged with the full commit SHA (what
  Nomad job specs pin to), plus `latest` on the default branch and the semver version on `v*` tags.

  The repository was renamed from `credential-issuer` on 2026-09-04, and the image path follows the
  repository name. Images built before the rename are still at
  `ghcr.io/anyone-protocol/credential-issuer` and were not copied over, so anything pinning a
  pre-rename SHA must keep using the old path.

Publishing authenticates with the built-in `GITHUB_TOKEN` — no repository secret to configure.

**Deploying is manual and separate.** A push publishes an image and stops; the stage Nomad job runs
only when a `workflow_dispatch` ticks `deploy`, so merging never moves the sandbox on its own. The
same dispatch takes a `conformance_url` to run the buyer harness against a deployed endpoint. See
[docs/deployment.md](docs/deployment.md).

## Layout

```
├── package.json                bun workspaces (apps/*, packages/*), root scripts
├── tsconfig.base.json          shared strict TS config
├── compose.yml                 local backing services (redis, postgres)
├── compose.full.yml            the above plus the issuer built from source
├── compose.published.yml       the above plus the published image, nothing built
├── config/keys/                epoch key + key document, gitignored, mounted at runtime
├── scripts/scenario-report.ts  scope scenario coverage by milestone
├── scripts/fake-proxy.ts       stands in for the TOON proxy to rehearse the 402 flow
├── operations/                 Nomad jobspecs: issuer, postgres, redis, epoch rotation (stage)
├── .github/workflows/ci.yaml   test, publish image, manual deploy + conformance
├── docs/
│   ├── issuer-mvp-scope.md     scope, invariants, BDD scenarios (spec of record)
│   ├── toon-runbook.md         run it, drive a purchase, implement the proxy side
│   ├── deployment.md           Nomad jobs, Vault secrets, deploying, the M0.3 conformance run
│   ├── credential-parameters.md  k, epoch length, serial and schema: decisions still open
│   ├── payment-claim.md        proposed proxy claim interface, pending TOON
│   ├── buyer-harness.md        harness CLI, library API, conformance checks
│   └── test-vectors.md         published RFC 9474 vectors and how they cross-verify
├── test-vectors/               committed vectors, checked by both implementations
├── tools/circl-crossverify/    Go cross-verifier (CIRCL), run as its own CI job
├── packages/buyer-harness/     headless buyer: library + CLI, TOON's conformance tool
└── apps/backend/src/
    ├── bundles/                POST /v1/bundles: the crypto rail's admission
    ├── entitlements/           POST /v1/entitlements: the fiat rail's drip schedule
    ├── keys/                   GET /v1/keys/current, key document schema
    ├── issuance/               the one signing path both rails share, and the I5 record
    ├── payment/                claim parsing and verification, rate limiter
    ├── accounting/             epoch counters, reconciliation job, alarms
    ├── config/                 k and blob sizes
    ├── signing/                RFC 9474 BlindSign, on a worker thread pool
    ├── testing/                harness and the scope scenario coverage gate
    └── database/, queue/       Postgres and Redis wiring
```
