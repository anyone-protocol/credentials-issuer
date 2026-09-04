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

M0.1, M0.2, M0.4 and M1.1 complete. Issuance is **real**: the issuer blind-signs under an epoch RSA
key with `@cloudflare/blindrsa-ts`, the harness blinds, unblinds and verifies, and the published
test vectors cross-verify against CIRCL. Still missing: the payment claim is parsed but not
verified (M1.4), and epoch keys are files rather than Vault-managed and never rotate (M1.2). Do not
expose this outside the sandbox.

| Endpoint | Milestone | State |
| -------- | --------- | ----- |
| `GET /healthz` | | live |
| `POST /v1/bundles` | M0.1, M0.2, M1.1 | live, real RFC 9474 blind signatures |
| `GET /v1/keys/current` | M0.1 | live, static file (Vault-backed epoch keys land in M1.2) |

Next: M1.2 (epoch key lifecycle in Vault), M1.4 (payment claim verification), and M0.3 (sandbox
deployment behind the TOON proxy).

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

### `GET /v1/keys/current`

Serves the static key document (I4) as `{epoch_id, not_before, not_after, alg, pubkey}`.
`root_sig` is added in M1.2 when the issuer root key exists.

At boot the issuer validates the document, loads the epoch signing key, and checks that the two
match. Publishing a pubkey that cannot verify our own signatures is worse than not starting, so a
mismatch stops startup.

## Epoch keys

The signing key is a PKCS#8 PEM at `ISSUER_PRIVATE_KEY_PATH`, and the key document at
`KEY_DOCUMENT_PATH` publishes its public half. Neither is committed and neither is baked into the
image: the container mounts them at runtime, and from M1.2 they come from Vault.

For local work, generate a throwaway pair:

```sh
bun run keys:dev          # writes config/keys/current.pem + current.json, both gitignored
```

The test suite generates them on first run, so a fresh clone needs no extra step.

### Typed errors

All errors return `{ "error": { "code": ..., "message": ... } }`.

| Code | Status | Cause |
| ---- | ------ | ----- |
| `REQUEST_INVALID` | 400 | Body is not an object, or `epoch` is missing. Not a scope-defined code, see [docs/payment-claim.md](docs/payment-claim.md). |
| `BUNDLE_SIZE` | 400 | `blinded_blanks` length is not `k`. |
| `BLANK_FORMAT` | 400 | A blank is not base64, does not decode to the configured blank size, or is not a valid blinded message for the epoch key. |
| `CLAIM_INVALID` | 402 | Payment claim missing or malformed. |
| `IDEMPOTENCY_CONFLICT` | 409 | `Idempotency-Key` reused for a different request. Not a scope-defined code. |
| `RATE_LIMITED` | 429 | Too many requests for this `payment_ref`. |

Count is checked before format, so a request that is both over-count and malformed reports
`BUNDLE_SIZE`.

## Buyer harness

A headless buyer and conformance tool, shipped as a library plus CLI in
[packages/buyer-harness](packages/buyer-harness/). TOON can point it at any issuer deployment to
check it against the contract; it is also the seed of the future agent SDK.

```sh
bun run harness --url http://localhost:3000
```

It exits `0` conforming, `1` nonconforming (naming the failed checks), and `2` when the run could
not happen at all. Full flag list, library API and the M1.1 upgrade path are in
[docs/buyer-harness.md](docs/buyer-harness.md).

## Configuration

`k` and the blob sizes are provisional and bind in config until the 0.3 credential spec lands
(scope: "Inputs needed before M1 starts").

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `BUNDLE_SIZE` | `10` | `k`, credentials per bundle. Placeholder pending 0.3. |
| `BLANK_SIZE_BYTES` | `256` | Expected decoded size of each blinded blank (RSA-2048). |
| `SIGNATURE_SIZE_BYTES` | `256` | Size of each returned blob (RSA-2048). |
| `KEY_DOCUMENT_PATH` | `config/keys/current.json` | Static key document to serve. |
| `ISSUER_PRIVATE_KEY_PATH` | `config/keys/current.pem` | Epoch signing key, PKCS#8 PEM. |
| `RATE_LIMIT_MAX` | `60` | Requests per window, per `payment_ref`. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit window length. |

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
  vacuously.

Which milestones are enforced is one line, `IMPLEMENTED_MILESTONES` in
[scope-scenarios.ts](apps/backend/src/testing/scope-scenarios.ts). Flip a milestone on in the
commit that lands it. Until then its scenarios show in the report but do not block CI, so unbuilt
scope never fails the build.

```sh
bun run scenarios      # coverage by milestone; also a CI step
```

Tests that are not scope scenarios use plain `it()` and are free-form. Behavior that needs a
scenario and has none is a question for the scope owner, not a scenario to add here.

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
docker build -f apps/backend/Dockerfile -t credential-issuer .
```

Base `oven/bun:1`, runs the TypeScript sources directly, listens on `$PORT` (default 3000),
healthcheck on `/healthz`.

## CI / publishing

[.github/workflows/ci.yaml](.github/workflows/ci.yaml) runs on `ubuntu-latest`.

- Every push and pull request: `bun install`, `bunx tsc --noEmit`, `bun test`, and a separate
  `crossverify` job that checks the published test vectors against CIRCL in Go
  ([docs/test-vectors.md](docs/test-vectors.md)).
- Pushes to the default branch and `v*` tags additionally publish the image to the GitHub Container
  Registry at `ghcr.io/anyone-protocol/credential-issuer`, tagged with the full commit SHA (what
  Nomad job specs pin to), plus `latest` on the default branch and the semver version on `v*` tags.

Publishing authenticates with the built-in `GITHUB_TOKEN` — no repository secret to configure.

## Layout

```
├── package.json                bun workspaces (apps/*, packages/*), root scripts
├── tsconfig.base.json          shared strict TS config
├── compose.yml                 local backing services (redis, postgres)
├── compose.full.yml            the above plus the issuer in a container
├── config/keys/                epoch key + key document, gitignored, mounted at runtime
├── scripts/scenario-report.ts  scope scenario coverage by milestone
├── .github/workflows/ci.yaml   test + publish image
├── docs/
│   ├── issuer-mvp-scope.md     scope, invariants, BDD scenarios (spec of record)
│   ├── payment-claim.md        proposed proxy claim interface, pending TOON
│   ├── buyer-harness.md        harness CLI, library API, conformance checks
│   └── test-vectors.md         published RFC 9474 vectors and how they cross-verify
├── test-vectors/               committed vectors, checked by both implementations
├── tools/circl-crossverify/    Go cross-verifier (CIRCL), run as its own CI job
├── packages/buyer-harness/     headless buyer: library + CLI, TOON's conformance tool
└── apps/backend/src/
    ├── bundles/                POST /v1/bundles, request validation
    ├── keys/                   GET /v1/keys/current, key document schema
    ├── issuance/               the I5 retention record, and nothing more
    ├── payment/                payment claim parsing, rate limiter
    ├── config/                 k and blob sizes
    ├── signing/                RFC 9474 BlindSign under the epoch key
    ├── testing/                harness and the scope scenario coverage gate
    └── database/, queue/       Postgres and Redis wiring
```
