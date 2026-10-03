# Triple Dispute Platform

A dispute-case service for an issuer's chargeback operations team, so that scheme deadlines are not
missed and any case can be reconstructed years later.

Built from the brief in [`technical-exercise.md`](./technical-exercise.md).

---

## Requirements

You need exactly two things:

| Requirement | Version | Why |
| --- | --- | --- |
| **Node.js** | 22.13 or newer | Check with `node --version`. If you use `nvm`, `nvm use` picks the pinned version from `.nvmrc`. |
| **Docker** | any recent version | Runs PostgreSQL, and the optional SQL linter and secret scanner. |

**You do not need Python.** The SQL linter runs inside a Docker container. See
[SQL linting](#sql-linting).

Nothing else is required: no global installs, no database client, no separate package manager.

---

## Quick start

```bash
git clone <this-repo> triple-dispute
cd triple-dispute

cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run dev
```

Then:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
open http://localhost:3000/docs
```

`npm run db:up` blocks until PostgreSQL reports healthy, so by the time it returns the database is
ready to accept connections.

---

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the API with reload on port 3000 |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with a V8 coverage report and thresholds |
| `npm run typecheck` | `tsc --noEmit` across the whole project |
| `npm run lint` / `npm run lint:fix` | ESLint with type-aware rules, zero warnings allowed |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run db:up` / `db:down` / `db:reset` | Start, stop, or recreate the database from scratch |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:status` | List applied and pending migrations |
| `npm run lint:sql` | sqlfluff 4.4.0 inside Docker |
| `npm run scan:secrets` | gitleaks 8.30.1 inside Docker, over the full git history |

`scripts/` holds only command-line entry points: `migrate.ts` today, the performance fixture
generator in phase 5.

---

## HTTP surface

The full contract is generated from the code and served at `/docs`, with the raw document at
`/docs/openapi.json`. One schema per endpoint drives request validation, the response type and the
OpenAPI definition, so the contract cannot drift from the implementation.

| Method | Path | Purpose | Phase |
| --- | --- | --- | --- |
| `GET` | `/healthz` | Liveness. Does not touch the database. | done |
| `GET` | `/readyz` | Readiness, including a real database round trip. | done |
| `GET` | `/metrics` | Prometheus metrics. | done |
| `GET` | `/docs` | Interactive API reference. | done |
| `GET` | `/docs/openapi.json` | Raw OpenAPI 3.1 document. | done |
| `POST` | `/cases` | Create a case, idempotent on `external_ref` | 3 |
| `GET` | `/cases/:id` | Current state | 3 |
| `GET` | `/cases?external_ref=` | Look up by the bank's own id | 3 |
| `POST` | `/cases/:id/transitions` | `{ to, reason }`, decided by the terminal rules | 3 |
| `POST` | `/cases/:id/notes` | Record work done on a case | 3 |
| `GET` | `/cases/:id/history?as_of=` | The case as recorded at an instant, with its events | 3 |
| `GET` | `/reports/stuck-queue` | At-risk and breached cases, ordered by money | 4 |

Paths are unversioned because banks already consume `GET /cases/:id`; changes are additive only.
The API accepts and returns `amount_cents`, the brief's field, alongside `amount_minor`. The full
contract is in [`docs/DOMAIN.md`](./docs/DOMAIN.md#http-contract).

### Examples

```bash
curl -s http://localhost:3000/healthz | jq
curl -s http://localhost:3000/readyz | jq
curl -s http://localhost:3000/metrics | grep http_request_duration
curl -s http://localhost:3000/docs/openapi.json | jq '.paths | keys'
```

---

## Architecture

The codebase is layered, and the boundaries are enforced by the linter rather than by convention:

```
src/
  domain/          Pure business logic. No database, no HTTP, no runtime globals.
                   Enforced by no-restricted-imports: importing pg, hono or pino here is a lint error.
  application/     Use cases. Orchestrates the domain and depends on ports, not adapters.
  infrastructure/  Postgres, connection pool, schema access, external clients.
  http/            Hono routes, OpenAPI schemas, auth middleware, error mapping.
  worker/          The deadline sweeper.
```

The rule that matters: `src/domain` cannot import from any outer layer. That is what makes the
business rules testable without a database, and it is checked on every lint run rather than trusted
to review.

### Key decisions

The full register, with rejected alternatives, is in [`NOTES.md`](./NOTES.md).

**[`docs/PHASES.md`](./docs/PHASES.md)** — the delivery phases, what each one delivers and its exit
criteria. Phases 0, 1 and 2 are complete.

**[`docs/DOMAIN.md`](./docs/DOMAIN.md)** — states, terminal rules, entities, flows, invariants and use
cases, written to be read without reading the code.

**[`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md)** — the trade-offs behind each review scenario, including
what the choice costs and what evidence would reverse it. This is the document to read before the
45-minute trade-off discussion.

**[`docs/MIGRATION_PLAN.md`](./docs/MIGRATION_PLAN.md)** — how migrations run against live data for
60+ tenants. Summarised [below](#migration-plan-against-live-data).

**[`AGENTS.md`](./AGENTS.md)** — the rules a coding agent must follow in this repository.

The decisions that shape the code most:

- **`case_events` is the truth and is append-only in the database itself**: the application role
  cannot update or delete, a trigger rejects it for every role, and a case with events cannot be
  deleted. `cases` is a projection written in the same transaction.
- **Rules decide on write; history never re-evaluates them.** Each event stores the status and the
  rule that produced it, so changing a rule never rewrites the past.
- **One clock.** `recorded_at` is PostgreSQL's `now()`, set by a trigger; clients cannot backdate.
- **Deadlines follow the scheme's calendar**, UTC by default, snapshotted on the case, compared with a
  half-open interval.
- **The contract banks already use is kept**: `/cases/:id`, and `amount_cents` in the API even though
  the column is `amount_minor`, because the brief's field name is wrong for JPY and KWD.
- **The tenant comes only from the verified token.**

---

## Database

PostgreSQL 17 in Docker, container name `triple-postgres`, published on port **5433** so it does not
collide with a PostgreSQL you may already be running locally.

```bash
npm run db:up        # start and wait for healthy
npm run db:migrate   # apply migrations
npm run db:down      # stop, keep the volume
npm run db:reset     # destroy the volume and start clean
```

Credentials are `triple` / `triple` on database `triple`, matching `.env.example`. The container runs
in UTC with `data-checksums` enabled.

### Migrations

Hand-written SQL in `migrations/`, applied in filename order by `npm run db:migrate`. The rules are
in [`migrations/README.md`](./migrations/README.md).

The runner records a SHA-256 per migration and refuses to run if an applied file changed, holds an
advisory lock so two deploys cannot migrate at once, sets `lock_timeout` so a transactional migration
never queues in front of live traffic, supports per-migration transaction control because
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, cleans up after a failed concurrent
build, and refuses to touch a database that has tables but no `triple_migrations` ledger.

```bash
npm run db:migrate
npm run db:migrate:status
```

## Migration plan against live data

The full plan is [`docs/MIGRATION_PLAN.md`](./docs/MIGRATION_PLAN.md). In short:

- **One shared database, `tenant_id` on every table.** Schema changes run once; data steps run tenant
  by tenant: one or two canary tenants, then about 10%, then the rest, largest last.
- **Every migration is safe on a live table**: `lock_timeout` on strong locks, indexes `CONCURRENTLY`,
  nullable columns first, `NOT NULL` via `CHECK … NOT VALID` + `VALIDATE`, never `ALTER COLUMN TYPE`,
  backfills in idempotent batches.
- **Expand, migrate, contract** across releases, so rollback is always "deploy the previous version";
  only the contract step is irreversible, and public API fields are never contracted.
- **Verification per tenant** is SQL that returns zero rows when healthy (projection equals the event
  log, no invalid indexes, no missing values).
- **Planned downtime: none.**

---

## Quality gates

**On every commit** (only staged files, via husky and lint-staged): `eslint --fix --max-warnings 0`
and `prettier --write`.

**On push:** `typecheck`, `lint`, `test`, `build`.

**In CI:** `format:check`, `typecheck`, `lint`, migrations applied twice to prove idempotency,
`test:coverage`, `build`; plus sqlfluff, gitleaks over the full history, and commitlint, each in its
own job.

The test suite runs without PostgreSQL: database tests skip themselves when the server is unreachable.
When it is reachable, each suite creates a throwaway database, migrates it, and drops it, so tests
never touch your data.

### Conventions the tooling enforces

- **No `console`** in `src/`, via ESLint. `linterOptions.noInlineConfig` means no source file can
  switch a rule off; exceptions live in `eslint.config.js`, where they are reviewed.
- **No committed credentials**: gitleaks in CI.
- **Layer boundaries**: `src/domain` cannot import infrastructure, HTTP or I/O.
- **Strict TypeScript**, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Deterministic ordering** of imports, object keys and union members.
- **Coverage thresholds** in `test:coverage`; the branch threshold is a floor to raise as domain logic
  lands.

---

## SQL linting

```bash
npm run lint:sql
```

[sqlfluff](https://github.com/sqlfluff/sqlfluff) 4.4.0 in Docker, configured in `.sqlfluff`. It owns
both layout and semantic rules for `migrations/`; Prettier does not format SQL. No Python is needed.

---

## Configuration

All configuration is environment-based and validated with Zod at startup, so a missing or malformed
variable fails immediately with a precise message instead of surfacing as a runtime error later.

Copy `.env.example` to `.env`. The scripts load it automatically via Node's
`--env-file-if-exists`, so nothing extra is needed to run them.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | `debug` in the example file |
| `DATABASE_URL` | `postgres://triple:triple@localhost:5433/triple` | |
| `DATABASE_POOL_MAX` | `10` | |
| `AUTH_MODE` | `dev` | `dev` or `oidc` |
| `JWT_ISSUER` / `JWT_AUDIENCE` / `JWT_JWKS_URL` | — | Verified on every request |
| `SWEEP_INTERVAL_MS` | `60000` | Deadline sweeper period |
| `TENANT_ID` / `TENANT_NAME` / `TENANT_TIMEZONE` / `TENANT_BASE_CURRENCY` | — | Seed values for the single-tenant hypothesis; the time zone is for display only |

---

## Troubleshooting

**`npm install` fails with `Cannot read properties of null (reading 'edgesOut')`**

You are probably not using the committed `.npmrc`. npm 10.9.2 has a known crash resolving the
optional peer set of Vitest 5. The committed `.npmrc` sets `legacy-peer-deps=true` so this does not
happen; make sure you did not delete it or run npm with `--userconfig` elsewhere.

**Port 5433 or 3000 already in use**

```bash
lsof -ti:5433 | xargs kill    # or change ports in docker-compose.yml and .env
lsof -ti:3000 | xargs kill
```

**`readyz` returns 503**

PostgreSQL is not reachable. Check `docker ps` for `triple-postgres` and run `npm run db:up`.

**`Cannot find package 'vite'`**

Peer dependencies are not auto-installed because of `legacy-peer-deps`. `vite` is declared directly,
so a clean `npm install` resolves it; if node_modules is in a strange state, remove it and reinstall.

---

## Project status

Phases 0, 1 and 2 of 0–5 are complete: toolchain and gates, the schema, the migration runner, the
live-data plan, and the domain core (rules, deadlines, money, events, history). What is deliberately unfinished is listed in [`NOTES.md`](./NOTES.md) section 4.

| Document | Contents |
| --- | --- |
| [`docs/PHASES.md`](./docs/PHASES.md) | Delivery phases and exit criteria |
| [`docs/DOMAIN.md`](./docs/DOMAIN.md) | States, rules, clocks, schema, API contract, invariants |
| [`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md) | Trade-offs per review scenario, deviations from the brief |
| [`docs/MIGRATION_PLAN.md`](./docs/MIGRATION_PLAN.md) | Migrations against live data for 60+ tenants |
| [`NOTES.md`](./NOTES.md) | How AI was used, failed prompts, decision register, open gaps |
| [`AGENTS.md`](./AGENTS.md) | Rules for coding agents |
| [`migrations/README.md`](./migrations/README.md) | Migration conventions and the runner |
