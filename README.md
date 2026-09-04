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

Pre-M0. The repository is the stack skeleton only; the issuer endpoints are not built yet.

| Endpoint | Milestone | State |
| -------- | --------- | ----- |
| `GET /healthz` | — | live |
| `POST /v1/bundles` | M0.1 | not built |
| `GET /v1/keys/current` | M0.1 | not built |

The `api/examples` and `api/jobs` controllers are template placeholders that prove the Postgres and
Redis wiring. They get deleted as the real endpoints land.

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

Run the tests with `bun test` and the typecheck with `bunx tsc --noEmit`.

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
├── .github/workflows/ci.yaml   test + publish image
├── docs/issuer-mvp-scope.md    scope, invariants, BDD scenarios (spec of record)
└── apps/backend/               NestJS service
```
