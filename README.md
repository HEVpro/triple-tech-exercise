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
| **Docker** | any recent version | Runs PostgreSQL, and the optional secret scanner. |

Nothing else is required: no global installs, no database client, no separate package manager.

---

## How to run it and call it

Five minutes from a clean clone to a case moving through its lifecycle. Every command below is
copy-paste; the only prerequisites are in [Requirements](#requirements).

### 1. Install and start the database

```bash
git clone https://github.com/HEVpro/triple-tech-exercise.git triple-dispute
cd triple-dispute
cp .env.example .env
npm install
npm run db:up
```

`db:up` starts PostgreSQL 17 in Docker on port **5433** and waits until it is healthy.

### 2. Create the schema and the demo data

```bash
npm run db:migrate
npm run dev:seed
```

- `db:migrate` builds the schema as the database owner.
- `dev:seed` creates **`triple_api`**, the restricted role the API connects as (it can read and
  append, never update or delete the audit trail), and two demo banks:

  | Tenant | `--tenant` | Base currency | Rule order |
  | --- | --- | --- | --- |
  | Acme Issuer | `acme` | EUR | default |
  | Globex Bank | `globex` | USD | scheme outcome before the deadline (step 10) |

Both commands are idempotent: running them again changes nothing.

### 3. Start the API

```bash
npm run dev
```

It listens on `http://localhost:3000`. The interactive reference is at
[`http://localhost:3000/docs`](http://localhost:3000/docs).

### 4. Get a token

The API takes the tenant and the actor **only** from a signed bearer token. In development you mint
one locally; there is no login endpoint.

```bash
export TOKEN=$(npm run -s dev:token)
export GLOBEX=$(npm run -s dev:token -- --tenant globex)
```

Options: `--tenant acme|globex`, `--actor human|agent`, `--sub <id>`, `--ttl <minutes>` (default 60).
Remember to change the variable name exported as parameter in the following curls.
E.g.: if you export GLOBEX, you should change TOKEN to GLOBEX in the following curls.

### 5. Call it

A helper for dates, so the examples work on any day and any OS:

```bash
export PRESENTED=$(node -e "console.log(new Date(Date.now()-40*864e5).toISOString().slice(0,10))")
```

**Create a case** (review scenario 1: Visa, presented 40 days ago, about five days left):

```bash
curl -s -X POST http://localhost:3000/cases \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"external_ref\":\"ACME-2026-0001\",\"amount_cents\":125000,\"currency\":\"EUR\",\"scheme\":\"VISA\",\"reason_code\":\"10.4\",\"presentment_date\":\"$PRESENTED\"}"
```

`201` the first time; sending the same body again returns `200` with the same case (idempotent on
`external_ref`).

**Find it by your own reference**, and keep its id for the next calls:

```bash
curl -s "http://localhost:3000/cases?external_ref=ACME-2026-0001" -H "authorization: Bearer $TOKEN"
export CASE_ID=$(curl -s "http://localhost:3000/cases?external_ref=ACME-2026-0001" -H "authorization: Bearer $TOKEN" | node -pe "JSON.parse(require('fs').readFileSync(0)).items[0].id")
```

**Fetch it by id:**

```bash
curl -s http://localhost:3000/cases/$CASE_ID -H "authorization: Bearer $TOKEN"
```

**File evidence** (the rules decide: allowed only before the deadline):

```bash
curl -s -X POST http://localhost:3000/cases/$CASE_ID/transitions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"UNDER_REVIEW","reason":"proof of delivery","evidence_refs":["DOC-881"]}'
```

**Record work** without changing the status:

```bash
curl -s -X POST http://localhost:3000/cases/$CASE_ID/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"requested proof of delivery from the merchant"}'
```

**Record the scheme's decision:**

```bash
curl -s -X POST http://localhost:3000/cases/$CASE_ID/transitions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"to\":\"WON\",\"reason\":\"scheme ruled for the issuer\",\"scheme_decision_ref\":\"VROL-42\",\"scheme_decided_on\":\"$(node -e "console.log(new Date().toISOString().slice(0,10))")\"}"
```

**Read the history**, now or as of any earlier instant:

```bash
curl -s http://localhost:3000/cases/$CASE_ID/history -H "authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/cases/$CASE_ID/history?as_of=2026-01-01T00:00:00Z" -H "authorization: Bearer $TOKEN"
```

**Review scenario 2** (Mastercard, presented 50 days ago): the case is `LOST` the moment it is
created, with a `DEADLINE_EXPIRED` event by the `system` actor dated at the deadline.

```bash
curl -s -X POST http://localhost:3000/cases \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"external_ref\":\"ACME-2026-0002\",\"amount_cents\":90000,\"currency\":\"EUR\",\"scheme\":\"MASTERCARD\",\"reason_code\":\"4853\",\"presentment_date\":\"$(node -e "console.log(new Date(Date.now()-50*864e5).toISOString().slice(0,10))")\"}"
```

**Money in another currency, for a USD bank:** the same euros, normalised to Globex's base
currency (`amount_base_minor`, `base_currency: "USD"`):

```bash
curl -s -X POST http://localhost:3000/cases \
  -H "authorization: Bearer $GLOBEX" -H 'content-type: application/json' \
  -d "{\"external_ref\":\"GLOBEX-1\",\"amount_cents\":125000,\"currency\":\"EUR\",\"scheme\":\"VISA\",\"reason_code\":\"10.4\",\"presentment_date\":\"$PRESENTED\"}"
```

**Tenant isolation:** Globex cannot see Acme's case, and the answer is `404`, not `403`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/cases/$CASE_ID -H "authorization: Bearer $GLOBEX"
```

**Errors** always have the same shape:

```bash
curl -s http://localhost:3000/cases/$CASE_ID
# {"error":{"code":"unauthenticated","message":"a bearer token is required"}}
```

| Status | `error.code` |
| --- | --- |
| 400 | `validation_failed` (with `details`: one entry per invalid field) |
| 401 | `unauthenticated` |
| 403 | `tenant_not_found` |
| 404 | `case_not_found`, `route_not_found` |
| 409 | `rule_conflict` (with the rule that decided), `case_closed`, `external_ref_conflict` |
| 422 | `not_an_action`, `unsupported_currency`, `presentment_in_future`, `response_window_missing` |

### 6. Run the deadline sweeper

The sweeper records the automatic loss of every `OPEN` case whose deadline has passed. In a second
terminal:

```bash
npm run worker      # loops every SWEEP_INTERVAL_MS (60 s); Ctrl-C stops after the current pass
npm run sweep       # or: one pass and exit
```

In production the one-pass form is what a scheduler would run every minute (an EventBridge rule
invoking a Lambda, or a Kubernetes CronJob); see `docs/TRADEOFFS.md` §7b.

### 7. Read the stuck-queue report

Where the bank is losing money: a summary of every state, and the cases that need action first,
ordered by amount in the bank's base currency.

```bash
curl -s "http://localhost:3000/reports/stuck-queue" -H "authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/reports/stuck-queue?state=at_risk,breached,responded&risk_window_days=14&limit=20" -H "authorization: Bearer $TOKEN"
```

| `deadline_state` | Meaning |
| --- | --- |
| `at_risk` | `OPEN`, deadline within the window: act now |
| `breached` | the deadline passed without an answer: money already lost |
| `responded` | evidence filed in time, waiting for the card network (counted in `summary`, listed with `?state=responded`) |

`next_cursor` in the response is passed back as `?cursor=` for the next page.

### 8. A million cases to explore (optional)

```bash
npm run seed:perf       # adds 1M cases with their full event history to your database, ~1 min
                        # (-- --rows 10000000 for the brief's 10M: ~21 min, 10 GB)
npm run perf:explain    # EXPLAIN (ANALYZE, BUFFERS) of the SQL the API actually runs
```

The cases go into the development database itself, mostly under Acme, so everything above works on
them with the same token: the report now lists thousands of cases, and any case's history shows the
events that explain its status (`external_ref` `PERF-…`; `PERF-HISTORY-400` has 400 events).
`npm run seed:perf -- --rows 100000` is a lighter run.

- Seeded events are recorded at seeding time, because `recorded_at` is always the database clock;
  a history `as_of` an earlier instant shows nothing.
- It runs once: the event log is append-only. To start over:
  `npm run db:reset && npm run db:migrate && npm run dev:seed && npm run seed:perf`.
- To look at the data directly: `docker exec -it triple-postgres psql -U triple -d triple`.

### 9. The console (optional)

With the API running, open <http://localhost:3000/console>, paste the token from step 4 and press
**Load**:

- **Queue**: money and number of cases at risk, breached and responded, with a bar for each one's
  share of the money in the queue.
- **Table**: the cases ordered by money, with their deadline and the time left; filter by state,
  change the risk window, load more.
- **History**: click a case to see every event (who, from which status to which, which rule
  decided, when), and pick an instant to see the case as it was recorded then.

It is one static page that calls the same API as the cURL commands above; it adds no endpoint and
holds no logic. It is a development tool: it is not served when `NODE_ENV=production`. Why it is
built this way, and what a real frontend would need instead, is in
[`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md) §16.

### 10. Rule order per bank (optional)

The terminal rules are evaluated in an order each bank can configure (`tenant_rule_config`). Acme
uses the default; `dev:seed` gives Globex one row that puts the scheme's outcome before the
deadline. The order changes one decision: **no evidence, the deadline has passed, and the scheme's
outcome arrives before the sweeper has recorded the loss.**

The API cannot create that situation directly (a case created late is `LOST` at once), so the
example moves a deadline into the past by hand, as time would:

```bash
for BANK in acme:EUR globex:USD; do
  TOKEN=$(npm run -s dev:token -- --tenant ${BANK%%:*})
  CASE_ID=$(curl -s -X POST http://localhost:3000/cases \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"external_ref\":\"RULES-$(date +%s)\",\"amount_cents\":50000,\"currency\":\"${BANK##*:}\",\"scheme\":\"VISA\",\"reason_code\":\"10.4\",\"presentment_date\":\"$(node -e "console.log(new Date(Date.now()-10*864e5).toISOString().slice(0,10))")\"}" | jq -r .id)
  docker exec triple-postgres psql -U triple -d triple -qc \
    "UPDATE cases SET deadline_at = now() - interval '1 hour' WHERE id = '$CASE_ID'"
  curl -s -X POST http://localhost:3000/cases/$CASE_ID/transitions \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"to\":\"WON\",\"reason\":\"scheme ruled for the issuer\",\"scheme_decision_ref\":\"VROL-42\",\"scheme_decided_on\":\"$(date -u +%F)\"}" \
    | jq -c '{bank: "'${BANK%%:*}'", error: .error.code, decided_by: (.error.details.decided_by.rule_key // .case.decided_by_rule), status: .case.status}'
done
```

```json
{"bank":"acme","error":"rule_conflict","decided_by":"deadline_passed","status":null}
{"bank":"globex","error":null,"decided_by":"scheme_outcome","status":"WON"}
```

Acme refuses the outcome with a `409`: the deadline rule comes first and the case is lost. Globex
records what the scheme decided. To configure a bank, insert its rows as the database owner:

```sql
INSERT INTO tenant_rule_config (tenant_id, rule_key, priority)
VALUES ('22222222-2222-4222-8222-222222222222', 'scheme_outcome', 1);
```

Rules without a row keep their default position after the configured ones. The order never
switches a rule off, and never changes a case already decided: rules run when something is
written, and the decision is stored (`test/http/rule-order.integration.test.ts`).

### Starting over

```bash
npm run db:reset && npm run db:migrate && npm run dev:seed
```

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
| `npm run db:migrate` | Apply pending migrations, as the schema owner |
| `npm run db:migrate:status` | List applied and pending migrations |
| `npm run db:generate` | Generate a migration from a change to `src/infrastructure/db/schema` (drizzle-kit) |
| `npm run db:generate:custom -- --name <name>` | Empty migration for what drizzle-kit cannot express (triggers, grants, `CONCURRENTLY`, reference data) |
| `npm run db:schema:check` | Fail if the TypeScript schema changed without a migration |
| `npm run dev:seed` | Create the API role `triple_api`, the two demo tenants and Globex's rule order (idempotent) |
| `npm run dev:token` | Print a development bearer token (`--tenant`, `--actor`, `--sub`, `--ttl`) |
| `npm run worker` / `npm run sweep` | Deadline sweeper: a loop, or one pass and exit |
| `npm run start:worker` | The compiled sweeper loop (`dist/worker/main.js`) |
| `npm run seed:perf` | Add 1M cases with their events to the dev database (`--rows N`) |
| `npm run perf:explain` | Query plans of the report and history on the seeded data |
| `npm run scan:secrets` | gitleaks 8.30.1 inside Docker, over the full git history |

`scripts/` holds only command-line entry points: `migrate.ts`, `dev-seed.ts` and `dev-token.ts`
(with the shared `dev-tenants.ts`), `seed-perf.ts` and `perf-explain.ts`. The sweeper is not a
script: it ships with the application, in `src/worker`.

---

## HTTP surface

The full contract is generated from the code and served at `/docs`, with the raw document at
`/docs/openapi.json`. One schema per endpoint drives request validation, the response type and the
OpenAPI definition, so the contract cannot drift from the implementation.

| Method | Path | Purpose | Phase |
| --- | --- | --- | --- |
| `GET` | `/healthz` | Liveness. Does not touch the database. | done |
| `GET` | `/readyz` | Readiness, including a real database round trip. | done |
| `GET` | `/docs` | Interactive API reference. | done |
| `GET` | `/console` | The development console (one page over this API). Not served in production. | done |
| `GET` | `/docs/openapi.json` | Raw OpenAPI 3.1 document. | done |
| `POST` | `/cases` | Create a case, idempotent on `external_ref` | done |
| `GET` | `/cases/:id` | Current state | done |
| `GET` | `/cases?external_ref=` | Look up by the bank's own id | done |
| `POST` | `/cases/:id/transitions` | `{ to, reason, … }`, decided by the terminal rules | done |
| `POST` | `/cases/:id/notes` | Record work done on a case | done |
| `GET` | `/cases/:id/history?as_of=` | The case as recorded at an instant, with its events | done |
| `GET` | `/reports/stuck-queue` | Summary of every state, and at-risk and breached cases ordered by money | done |

Paths are unversioned because banks already consume `GET /cases/:id`; changes are additive only,
and the frozen contracts in `test/contract/` (case, history, stuck-queue report) fail the build if a
published field is removed, renamed or retyped.
The API accepts and returns `amount_cents`, the brief's field, alongside `amount_minor`. Every
`/cases` route needs a bearer token; see [How to run it and call it](#how-to-run-it-and-call-it).
The full contract is in [`docs/DOMAIN.md`](./docs/DOMAIN.md#http-contract).

### Examples

```bash
curl -s http://localhost:3000/healthz | jq
curl -s http://localhost:3000/readyz | jq
curl -s http://localhost:3000/docs/openapi.json | jq '.paths | keys'
```

---

## Architecture

The codebase is layered, and the boundaries are enforced by the linter rather than by convention:

```
src/
  domain/          Pure business logic. No database, no HTTP, no runtime globals.
                   Enforced by no-restricted-imports: importing pg, hono or pino here is a lint error.
  application/     Use cases, one transaction each. Depends on ports (CaseStore), never adapters.
  infrastructure/  Drizzle schema and queries (the CaseStore adapter), pool, migration runner.
  http/            Hono routes, Zod/OpenAPI schemas (drizzle-zod), auth, error envelope.
  worker/          The deadline sweeper.
```

The rule that matters: `src/domain` cannot import from any outer layer. That is what makes the
business rules testable without a database, and it is checked on every lint run rather than trusted
to review.

Inside, the domain is split into blocks, each a folder whose `index.ts` is its public API:

```
src/domain/
  shared/    CaseStatus, Actor
  money/     minor units, ISO 4217, base-currency conversion
  deadline/  calendar arithmetic and the deadline rule
  rules/     the terminal rules and a tenant's order
  events/    the event catalogue, metadata schemas, validation
  dispute/   the dispute-case aggregate: create, transition, sweep, note, history
```

Dependencies run one way (`shared ← money, deadline ← rules ← events ← dispute`), and ESLint rejects
an import that goes the other way or reaches into a block's internal file. The conventions are in
[`AGENTS.md`](./AGENTS.md#domain-structure).

### Key decisions

The full register, with rejected alternatives, is in [`NOTES.md`](./NOTES.md).

**[`docs/PHASES.md`](./docs/PHASES.md)** — the delivery phases, what each one delivers and its exit
criteria. All six phases are complete.

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
- **The tenant comes only from the verified token**, and the API connects to PostgreSQL as
  `triple_api`, a role that cannot update or delete the audit trail.
- **Libraries before custom code.** Drizzle defines the schema and the queries, drizzle-zod the
  request schemas, drizzle-kit generates migrations; only what they verifiably cannot do is custom,
  such as applying migrations (D-38).

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

The schema is defined once, in `src/infrastructure/db/schema` (Drizzle). drizzle-kit **generates**
the SQL migrations from it into `migrations/`; what it cannot express (the append-only trigger,
grants, `CONCURRENTLY` indexes, reference data) is written by hand as a drizzle-kit custom
migration. Our runner **applies** them, because drizzle's own migrator runs every pending
migration in one transaction, has no checksums and no lock (D-38). `0001`–`0010` predate drizzle-kit
and are kept as written; `test/schema-drift.integration.test.ts` proves the TypeScript schema
builds the same tables, columns and constraints. The rules are in
[`migrations/README.md`](./migrations/README.md).

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
`test:coverage`, `build`, and `db:schema:check`; plus gitleaks over the full history and
commitlint, each in its own job.

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

## Configuration

All configuration is environment-based and validated with Zod at startup, so a missing or malformed
variable fails immediately with a precise message. Copy `.env.example` to `.env`; the scripts load it
automatically.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | `debug` in the example file |
| `DATABASE_URL` | — | The API's connection, as `triple_api` (read and append only) |
| `MIGRATION_DATABASE_URL` | — | The owner's connection, for `db:migrate`, `dev:seed` and tests |
| `DATABASE_POOL_MAX` | `10` | |
| `AUTH_MODE` | `dev` | The only mode. The server refuses to start with `NODE_ENV=production` |
| `JWT_SECRET` | — | HS256 secret, at least 32 characters |
| `JWT_ISSUER` / `JWT_AUDIENCE` | — | Checked on every request |

The deadline sweeper reads only the database, logging, monitoring and `SWEEP_INTERVAL_MS` settings: it needs no
JWT secret and runs with `NODE_ENV=production`; the authentication settings belong to the API
alone.
| `SWEEP_INTERVAL_MS` | `60000` | Deadline sweeper period (phase 4) |
| `SENTRY_DSN` | — | Optional. Enables monitoring in the API and the sweeper ([`docs/SLOS.md`](./docs/SLOS.md)); nothing is sent without it |
| `SENTRY_TRACES_SAMPLE_RATE` | `1` | Share of requests traced, 0 to 1 |

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

**`readyz` returns 503, or every call fails with `password authentication failed for user "triple_api"`**

PostgreSQL is not reachable, or the API role does not exist yet. Check `docker ps` for
`triple-postgres`, then run `npm run db:up && npm run db:migrate && npm run dev:seed`.

**Every `/cases` call returns 401**

The token is missing or expired (default TTL 60 minutes), or `.env` changed since it was minted.
Mint a new one with `export TOKEN=$(npm run -s dev:token)`.

**`Cannot find package 'vite'`**

Peer dependencies are not auto-installed because of `legacy-peer-deps`. `vite` is declared directly,
so a clean `npm install` resolves it; if node_modules is in a strange state, remove it and reinstall.

---

## Project status

All six phases (0–5) are complete: toolchain and gates, the schema and migration runner with the
live-data plan, the domain core, the case API with development auth and tenant isolation, and the
stuck-queue report with the deadline sweeper. Phase 5 measured the report and the history on ten
million cases (17–24 ms and 4–6 ms per request) and defined the SLOs and the on-call alerts
([`docs/SLOS.md`](./docs/SLOS.md)). What is deliberately unfinished is listed in
[`NOTES.md`](./NOTES.md) section 4.

| Document | Contents |
| --- | --- |
| [`docs/PHASES.md`](./docs/PHASES.md) | Delivery phases and exit criteria |
| [`docs/DOMAIN.md`](./docs/DOMAIN.md) | States, rules, clocks, schema, API contract, invariants |
| [`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md) | Trade-offs per review scenario, deviations from the brief |
| [`docs/MIGRATION_PLAN.md`](./docs/MIGRATION_PLAN.md) | Migrations against live data for 60+ tenants |
| [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) | Measured plans and timings for review scenarios 3 and 4 |
| [`docs/SLOS.md`](./docs/SLOS.md) | What the service promises, which alerts page the person on call, and how it is watched |
| [`NOTES.md`](./NOTES.md) | How AI was used, failed prompts, decision register, open gaps |
| [`docs/transcript.md`](./docs/transcript.md) | The agent transcript: every prompt, answer and action, in order |
| [`AGENTS.md`](./AGENTS.md) | Rules for coding agents |
| [`migrations/README.md`](./migrations/README.md) | Migration conventions, drizzle-kit workflow and the runner |
