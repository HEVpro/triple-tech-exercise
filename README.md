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
| **Docker** | any recent version | Only used to run PostgreSQL and, optionally, the SQL linter. |

**You do not need Python.** The full SQL lint runs inside a Docker container. See
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
| `npm run db:check` | Verify connectivity and print server version, timezone and role |
| `npm run db:migrate` | Apply pending migrations (arrives in phase 1) |
| `npm run bench:smoke` / `bench:full` / `bench:spec` | Seed fixtures at 200k / 2M / 10M rows |
| `npm run lint:sql` | SQL lint via sqlfluff inside Docker |
| `npm run lint:sql:node` | SQL syntax and formatting check, pure Node, no Docker |
| `npm run guard:secrets` | Fail if a committed file matches a credential pattern |
| `npm run guard:console` | Fail if anything under `src/` uses `console` |

---

## HTTP surface

The full contract is generated from the code and served at `/docs`, with the raw document at
`/docs/openapi.json`. One schema per endpoint drives request validation, the response type and the
OpenAPI definition, so the contract cannot drift from the implementation.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness. Does not touch the database. |
| `GET` | `/readyz` | Readiness, including a real database round trip. |
| `GET` | `/metrics` | Prometheus metrics. |
| `GET` | `/docs` | Interactive API reference. |
| `GET` | `/docs/openapi.json` | Raw OpenAPI 3.1 document. |

Case and report endpoints are added in later phases.

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

**[`docs/PHASES.md`](./docs/PHASES.md)** — the seven delivery phases, what each one delivers and its
exit criteria. Phase 0 is complete.

**[`docs/DOMAIN.md`](./docs/DOMAIN.md)** — states, terminal rules, entities, flows, invariants and use
cases, written to be read without reading the code.

**[`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md)** — the trade-offs behind each review scenario, including
what the choice costs and what evidence would reverse it. This is the document to read before the
45-minute trade-off discussion.

The decisions that shape the code most:

- **`case_events` is an append-only log; `cases` is a read projection.** Events are the truth and can
  reconstruct any case at any past instant. The projection exists so that `GET /cases/:id` and the
  report stay fast. Both are written in the same transaction.
- **`tenant_id` is on every business table and is derived only from the verified token.** The project
  currently runs as a single tenant as an explicit hypothesis, but the schema and the auth path are
  already multi-tenant, so enabling it is a seed change rather than a rewrite.
- **Money is `amount_minor BIGINT` plus `currency`, not `amount_cents`.** The brief's field name is a
  defect: JPY has no decimal places and KWD has three. The scale comes from an ISO 4217 exponent map.
- **Deadlines are anchored to the tenant's calendar day and compared with a half-open interval.**
  `event_at < deadline_at`, so a boundary event is never simultaneously in and out of window.

---

## Database

PostgreSQL 17 in Docker, container name `triple-postgres`, published on port **5433** so it does not
collide with a PostgreSQL you may already be running locally.

```bash
npm run db:up        # start and wait for healthy
npm run db:check     # connectivity, version, timezone, role
npm run db:down      # stop, keep the volume
npm run db:reset     # destroy the volume and start clean
```

Credentials are `triple` / `triple` on database `triple`, matching `.env.example`. The container runs
in UTC with `data-checksums` enabled.

### Migrations

Migrations are hand-written plain SQL in `migrations/`, applied in filename order. See
[`migrations/README.md`](./migrations/README.md) for the rules, which are written for zero-downtime
changes against live data.

The runner supports per-migration transaction control, because `CREATE INDEX CONCURRENTLY` cannot run
inside a transaction and production indexes must stay inside the migration system to remain auditable.

---

## Quality gates

The gate is designed so that the fast checks are fast and the strict checks cannot be skipped.

**On every commit** (only staged files, via husky and lint-staged):

```bash
eslint --fix --max-warnings 0
prettier --write
npm run guard:secrets
```

**On push and in CI:**

```bash
npm run guard:console
npm run guard:secrets
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run build
```

The test suite runs without PostgreSQL: the database-backed tests skip themselves when the server is
unreachable, so `npm test` works on a fresh clone before `npm run db:up`. CI runs a PostgreSQL service
container so the integration tests actually execute there.

CI additionally runs the SQL lint in Docker, and validates commit messages against conventional
commits.

### Conventions the linter enforces

- **No `console`.** Blocked by `no-console` and `no-restricted-globals` in ESLint, and independently by
  `npm run guard:console`, which greps `src/` so the rule cannot be bypassed by disabling it.
  Application code logs through `pino` in `src/logger.ts`, with `authorization` and `cookie` headers
  redacted; scripts write to `process.stdout`.
- **No committed credentials.** `npm run guard:secrets` fails on private key blocks, AWS, GitHub,
  Slack, Google and Stripe tokens, hardcoded credential assignments and bearer literals. It is a
  floor, not a substitute for review.
- **Deterministic ordering** of imports, object keys and union members, so diffs stay reviewable.
- **Layer boundaries** as described above.
- **Strict TypeScript**, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. These
  are what stop an unchecked array access or an `undefined` optional from reaching production code,
  and they catch unsafe numeric coercion at compile time rather than in a reconciliation report.
- **Coverage thresholds** are enforced by `npm run test:coverage`. The branch threshold is set lower
  than the others because this codebase is early and most branches today are configuration paths;
  it is a floor to be raised as the domain logic lands, not a target.

---

## SQL linting

There are two SQL checkers, and neither is required to run the project.

```bash
npm run lint:sql        # sqlfluff, inside Docker. Full semantic rules.
npm run lint:sql:node   # pure Node. Syntax validation plus formatting. No Docker needed.
```

**Why both.** Migrations and the report query are the two artefacts a reviewer reads by eye, so
formatting consistency and semantic rules are worth having. But a linter that needs Python would mean
a fresh clone fails on a machine without it, which is not acceptable for a technical exercise.

**No Python is required, ever.** `npm run lint:sql` runs
[`ghcr.io/sqlfluff/sqlfluff`](https://hub.docker.com/r/sqlfluff/sqlfluff) in a container, and Docker is
already required for PostgreSQL. `npm run lint:sql:node` needs nothing beyond `npm install`.

**They do not fight each other.** Prettier is the single formatter for SQL, so sqlfluff's layout rule
family (`LT01` to `LT14`) is excluded and only semantic rules run. A repository where two formatters
disagree trains reviewers to ignore both.

If you have Python and prefer it natively, that works too:

```bash
pipx run sqlfluff lint --dialect postgres migrations/
```

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
| `TENANT_ID` / `TENANT_NAME` / `TENANT_TIMEZONE` / `TENANT_BASE_CURRENCY` | — | Seed values for the single-tenant hypothesis |

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

Postgres is not reachable. `npm run db:check` reports the connection error and the likely fix.

**`Cannot find package 'vite'`**

Peer dependencies are not auto-installed because of `legacy-peer-deps`. `vite` is declared directly,
so a clean `npm install` resolves it; if node_modules is in a strange state, remove it and reinstall.

---

## Project status

Phase 0 of 7 complete: repository, toolchain, gates and database container. The remaining phases, the
domain model and the trade-offs are specified in [`docs/`](./docs) and the gaps are listed explicitly
in [`NOTES.md`](./NOTES.md) section 4.

| Document | Contents |
| --- | --- |
| [`docs/PHASES.md`](./docs/PHASES.md) | Delivery phases and exit criteria |
| [`docs/DOMAIN.md`](./docs/DOMAIN.md) | States, rules, schema, flows, invariants, use cases |
| [`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md) | Trade-offs per review scenario, with reversal triggers |
| [`NOTES.md`](./NOTES.md) | How AI was used, failed prompts, decision register, open gaps |
| [`migrations/README.md`](./migrations/README.md) | Migration conventions and the zero-downtime rules |