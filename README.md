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

M0.1 complete: the API skeleton serves stub bundles and the static key document. Signatures are
random blobs of the right size, not real blind signatures, and the payment claim is parsed but not
verified. Do not expose this outside the sandbox.

| Endpoint | Milestone | State |
| -------- | --------- | ----- |
| `GET /healthz` | | live |
| `POST /v1/bundles` | M0.1 | live, stub blobs (real signing lands in M1.1) |
| `GET /v1/keys/current` | M0.1 | live, static file (Vault-backed epoch keys land in M1.2) |

Next: M0.2 (idempotency keys, rate limiting per `payment_ref`).

## API

### `POST /v1/bundles`

Issues exactly `k` credentials per call at one price (I3). The proxy's forwarded proof of payment
travels in the `X-Payment-Claim` header, specified in [docs/payment-claim.md](docs/payment-claim.md).

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

Serves the static key document (I4) as `{epoch_id, not_before, not_after, alg, pubkey}`. The
document is validated at boot, so a malformed file stops startup rather than surfacing later.
`root_sig` is added in M1.2 when the issuer root key exists.

The checked-in [config/keys/current.json](config/keys/current.json) is a development placeholder.
Its private key was generated and discarded, so nothing can sign under it.

### Typed errors

All errors return `{ "error": { "code": ..., "message": ... } }`.

| Code | Status | Cause |
| ---- | ------ | ----- |
| `REQUEST_INVALID` | 400 | Body is not an object, or `epoch` is missing. Not a scope-defined code, see [docs/payment-claim.md](docs/payment-claim.md). |
| `BUNDLE_SIZE` | 400 | `blinded_blanks` length is not `k`. |
| `BLANK_FORMAT` | 400 | A blank is not base64, or does not decode to exactly the configured blank size. |
| `CLAIM_INVALID` | 402 | Payment claim missing or malformed. |

Count is checked before format, so a request that is both over-count and malformed reports
`BUNDLE_SIZE`.

## Configuration

`k` and the blob sizes are provisional and bind in config until the 0.3 credential spec lands
(scope: "Inputs needed before M1 starts").

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `BUNDLE_SIZE` | `10` | `k`, credentials per bundle. Placeholder pending 0.3. |
| `BLANK_SIZE_BYTES` | `256` | Expected decoded size of each blinded blank (RSA-2048). |
| `SIGNATURE_SIZE_BYTES` | `256` | Size of each returned blob (RSA-2048). |
| `KEY_DOCUMENT_PATH` | `config/keys/current.json` | Static key document to serve. |

## Stack

- **Runtime** — [Bun](https://bun.sh). The service runs its TypeScript sources directly; there is no
  compile step. (The scope doc says "TypeScript / NestJS" without naming a runtime; Bun is the
  choice for this repo.)
- **Framework** — NestJS 11.
- **Postgres** via TypeORM — aggregates and entitlements. Per invariant I5 this holds counters and
  payment references only: never request bodies, IPs, or per-purchase detail beyond
  `{payment_ref, epoch, bundle_count, timestamp}`.
- **Redis** via BullMQ — background jobs (epoch rotation, reconciliation).
- **Blind signatures** — `@cloudflare/blindrsa-ts`, suite `RSABSSA-SHA384-PSS-Randomized`
  (added in M1.1; invariant I1 forbids any hand-rolled alternative).
- **Deployment** — Docker image on Nomad. Vault holds the epoch private keys.

## Local development

Requires Bun and a container runtime for Redis/Postgres. This host uses **Podman** locally;
deployments and CI use Docker. The compose files work with either — substitute `podman compose`
for `docker compose` below.

```sh
podman compose up -d        # redis + postgres
cp .env.example .env
bun install
bun run dev                 # NestJS with watch on :3000
```

```sh
curl localhost:3000/healthz
```

Run the tests with `bun test` and the typecheck with `bunx tsc --noEmit`. The scenario tests boot
the real app against Postgres, so bring the backing services up first. CI provides them as service
containers.

Test names are the Gherkin scenario names from
[docs/issuer-mvp-scope.md](docs/issuer-mvp-scope.md) verbatim, so the mapping from spec to suite
stays checkable by eye. The scenarios are the spec of record: do not rename or add without a scope
change.

To run the service itself in a container alongside the backing services:

```sh
podman compose -f compose.full.yml up --build
```

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

- Every push and pull request: `bun install`, `bunx tsc --noEmit`, `bun test`.
- Pushes to the default branch and `v*` tags additionally publish the image to the GitHub Container
  Registry at `ghcr.io/anyone-protocol/credential-issuer`, tagged with the full commit SHA (what
  Nomad job specs pin to), plus `latest` on the default branch and the semver version on `v*` tags.

Publishing authenticates with the built-in `GITHUB_TOKEN` — no repository secret to configure.

## Layout

```
├── package.json                bun workspaces (apps/*), root scripts
├── tsconfig.base.json          shared strict TS config
├── compose.yml                 local backing services (redis, postgres)
├── compose.full.yml            the above plus the issuer in a container
├── config/keys/current.json    static key document served by /v1/keys/current
├── .github/workflows/ci.yaml   test + publish image
├── docs/
│   ├── issuer-mvp-scope.md     scope, invariants, BDD scenarios (spec of record)
│   └── payment-claim.md        proposed proxy claim interface, pending TOON
└── apps/backend/src/
    ├── bundles/                POST /v1/bundles, request validation
    ├── keys/                   GET /v1/keys/current, key document schema
    ├── issuance/               the I5 retention record, and nothing more
    ├── payment/                payment claim parsing
    ├── config/                 k and blob sizes
    └── database/, queue/       Postgres and Redis wiring
```
