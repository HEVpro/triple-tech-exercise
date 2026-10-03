# Delivery Phases

The exercise is large enough that building it in one pass produces a codebase nobody can review. It
is therefore delivered in seven phases, each of which leaves the repository in a working state with
its gates green.

The phases are ordered so that the highest-risk decisions are made first, against real evidence,
rather than at the end. Two of them exist purely to produce evidence for a decision that is
deliberately deferred: partitioning (D-13) and the report index strategy.

Current status: **phase 0 complete**, phases 1 to 6 not started.

---

## Phase map

| Phase | Delivers | Primary risk retired |
| --- | --- | --- |
| 0 | Repository, toolchain, gates, PostgreSQL container | Can a reviewer run this at all |
| 1 | Schema, migration runner, migrations | Can we change live data safely |
| 2 | Domain core and terminal rules | Is the business logic auditable |
| 3 | Case API including `as_of` history | Do we reconstruct history truthfully |
| 4 | Auth and tenant isolation | Can a tenant see another tenant's data |
| 5 | Stuck-queue report and deadline sweeper | Do we find at-risk work in time |
| 6 | Performance evidence, SLOs, optional console | Does it hold at 10M rows |

Phases 3 and 4 could be swapped. They are kept in this order because auth changes the shape of every
handler, and it is cheaper to add it to three endpoints than to retrofit it across a growing surface.

---

## Phase 0: Foundation — complete

**Goal:** a reviewer can clone the repository and have a running, verifiable service in one command.

**Delivered:**

- TypeScript, Hono, Zod, Pino, Vitest, Drizzle, PostgreSQL 17 in Docker.
- ESLint `strictTypeChecked` with layer boundaries and a `console` ban, Prettier as the single
  formatter, commitlint, husky `pre-commit` and `pre-push`.
- Credential and `console` guards, duplicated into CI so they do not depend on local hooks.
- Coverage thresholds, four test files, `/healthz`, `/readyz`, `/metrics`, `/docs`.
- `README.md`, `NOTES.md`, `migrations/README.md`, and the documents in `docs/`.

**Exit criteria, all met:** `format:check`, `guard:console`, `guard:secrets`, `typecheck`, `lint`,
`test`, `test:coverage`, `build`, `lint:sql` and `lint:sql:node` pass on a clean tree; both husky
hooks verified to fail a bad commit and pass a good one; `npm install` succeeds without flags and
without Python installed.

---

## Phase 1: Schema and migrations

**Goal:** the data model a regulator could audit, and a migration path that is safe against live data
for 60+ tenants.

**Deliverables:**

- `0001_extensions.sql`, `0002_tenants_and_response_windows.sql`, `0003_cases.sql`,
  `0004_case_events.sql`, `0005_rule_config.sql`, `0006_report_indexes.sql`, plus a rollback note per
  migration.
- `scripts/migrate.ts`: applies in filename order, records `schema_migrations` with a checksum,
  supports **per-migration transaction control** (D-14) so `CREATE INDEX CONCURRENTLY` can be
  expressed in the migration system rather than by hand.
- `npm run db:migrate`, `db:migrate:status`, `db:rollback`.
- The live-data migration plan the brief asks for as a README deliverable, in
  `migrations/LIVE-DATA-PLAN.md`.
- Partial index for the stuck-queue report, created `CONCURRENTLY`.

**Exit criteria:**

- A second PostgreSQL can be created from an empty volume with one command.
- Every migration has a documented rollback or an explicit, justified statement that it is
  irreversible.
- The runner proves the non-transactional path with at least one `CONCURRENTLY` migration.
- Downtime for the live-data plan is stated in minutes, not adjectives.

**Decisions applied:** D-1, D-3, D-4, D-6, D-7, D-10, D-14, D-21.

**Watch out for:** the brief's `amount_cents` is renamed to `amount_minor` here, and every later phase
uses the new name. Doing this in phase 1 rather than phase 3 avoids a second migration.

---

## Phase 2: Domain core

**Goal:** all business logic in pure TypeScript with no database and no HTTP, so it can be tested
exhaustively and read without infrastructure.

**Deliverables:**

- `src/domain/money.ts`: minor-unit conversion driven by an ISO 4217 exponent map (D-4).
- `src/domain/deadline.ts`: `deadline_at` from `presentment_date + window_days` at end of day in the
  tenant's IANA timezone, DST-safe, half-open interval (D-6).
- `src/domain/events.ts`: the closed `CaseEvent` discriminated union with per-type metadata schemas
  and the 16 KB cap (D-10).
- `src/domain/terminal-rules.ts`: ordered predicates `deadlinePassed`, `evidenceFiled`,
  `schemeOutcome`, defaulting to `OPEN`, each returning the status *and* the rule that produced it
  (D-8, D-11).
- `src/domain/case.ts`: the state machine and its invariants.

**Exit criteria:**

- Zero imports from `http`, `infrastructure` or `pg` in `src/domain`, enforced by ESLint (D-16).
- Every rule has a unit test including the boundary: exactly at the deadline, one millisecond before,
  one millisecond after.
- The `as_of` invariant is asserted in a test: replaying with `clock = as_of` differs from replaying
  with `now()` for at least one fixture, which is the defect described in `NOTES.md` 2.8.

**Decisions applied:** D-4, D-6, D-8, D-10, D-11.

---

## Phase 3: Case API

**Goal:** the endpoint set the brief requires, with contracts that do not break existing integrations.

**Deliverables:**

- `POST /v1/cases`, `GET /v1/cases/:external_ref`, `POST /v1/cases/:external_ref/transitions`,
  `GET /v1/cases/:external_ref/history?as_of=`.
- One Zod schema per endpoint, shared between request validation, response typing and the OpenAPI
  document, so the contract cannot drift from the handler.
- Idempotency key on case creation, so a retried bank request does not create a duplicate case.
- Versioned response envelope with additive-only field changes.

**Exit criteria:**

- `POST`, `GET`, transition and history exercised with cURL commands that are committed to the README.
- The history endpoint reconstructs a case at a past instant for a case with 400 events, and the
  reconstruction is asserted event by event, not by eyeballing a status string.
- A response shape change is demonstrated to be backward compatible by adding a field in a test and
  showing existing assertions still pass.

**Decisions applied:** D-3, D-7, D-11, D-12.

---

## Phase 4: Auth and tenant isolation

**Goal:** a case's tenant comes from a verified credential and nowhere else.

**Deliverables:**

- JWT verification with `jose` against a JWKS, issuer and audience checked, on every request (D-12).
- `AUTH_MODE=dev` mints local HS256 tokens; that code path refuses to start when `NODE_ENV=production`.
- A cross-tenant access test that asserts a valid token for tenant A receives 404, not 403, for a case
  belonging to tenant B.

**Exit criteria:**

- The cross-tenant test fails if the tenant is read from a header, a body field or a query parameter.
- `AUTH_MODE=oidc` works against a real JWKS endpoint.

**Decisions applied:** D-1, D-12.

---

## Phase 5: Stuck-queue report and sweeper

**Goal:** find the money before the deadline finds it.

**Deliverables:**

- `GET /v1/reports/stuck-queue` with `risk_window_days`, defaulting to 7, filtered on
  `deadline_at <= now() + interval` and `status IN ('OPEN','UNDER_REVIEW')`, ordered by exposure.
- `src/worker/sweeper.ts`: periodic batch, `FOR UPDATE SKIP LOCKED`, idempotent, `system` actor
  (D-9), interval from `SWEEP_INTERVAL_MS`, default 60 s (D-22).
- The report orders by `amount_base_minor` using the fixed versioned FX normalisation (D-5), which is
  a deliberate deviation from the brief's `amount_cents DESC`: sorting raw minor units across
  currencies ranks a KWD case below a JPY case, which inverts the meaning of "exposure".

**Exit criteria:**

- The sweeper is idempotent: two concurrent workers produce one set of events.
- Review scenarios 1 and 2 return the expected rows.
- The report is covered by an index whose usage is shown by `EXPLAIN`, not assumed.

**Decisions applied:** D-2, D-5, D-9, D-22.

---

## Phase 6: Performance evidence, SLOs, optional console

**Goal:** produce the measurements the brief says the review will debate, and decide D-13 on evidence.

**Deliverables:**

- `scripts/bench.ts`: fixture generator for `smoke` 200k, `full` 2M default, `spec` 10M behind a flag
  (D-2).
- `docs/PERFORMANCE.md`: `EXPLAIN (ANALYZE, BUFFERS)` for the report and the history endpoint at 2M
  and 10M rows, plus vacuum and bloat figures.
- A written decision on partitioning, using that evidence. The current answer is no (D-13).
- `docs/SLOS.md`: what pages a human at 3am, with thresholds and the alert that fires.
- Optional one-page console: at-risk table and case history timeline. Plain component kit, no custom
  CSS, per the brief's instruction to favour function over polish.

**Exit criteria:**

- Scenario 3: history for a 400-event case under 200 ms, measured.
- Scenario 4: report under 100 ms for a 10M-row tenant, measured, with the plan attached.
- D-13 is either confirmed or reversed with numbers.

**Decisions applied:** D-2, D-13, and the evidence obligations of D-5 and D-22.

---

## Dependencies between phases

```
0 foundation
  └─ 1 schema ──┬─ 2 domain ──┬─ 3 case api ──┬─ 4 auth
                │             │                │
                └─────────────┴─ 5 report + sweeper
                                       └─ 6 evidence + console
```

Phase 2 is independent of phase 1 and could be built in parallel; keeping it sequential avoids
inventing an interface the schema then contradicts.

## What is deliberately not in scope

- **Frontend beyond the optional console.** The brief marks it optional and says to prefer function.
- **A rules admin API.** It is the natural injection and privilege-escalation surface that D-8 avoids
  by keeping predicates in code.
- **Notifications to scheme APIs.** Nothing in the brief asks for outbound integration, and it would
  put credentials on the critical path.
- **Partitioning**, until phase 6 says otherwise.