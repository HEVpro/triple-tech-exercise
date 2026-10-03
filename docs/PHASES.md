# Delivery Phases

Each phase leaves the repository working with its gates green. The plan was cut from seven phases to
six (0 to 5) after a scope review: the console, OIDC and effective-dated windows were dropped or
deferred (NOTES 2.13).

Current status: **phases 0 and 1 complete.**

---

## Phase map

| Phase | Delivers | Risk retired | Status |
| --- | --- | --- | --- |
| 0 | Repository, toolchain, gates, PostgreSQL container | Can a reviewer run this at all | done |
| 1 | Schema, migration runner, migration plan | Can we change live data safely; is the audit trail enforced by the database | done |
| 2 | Domain core: money, deadline, rules, events | Is the business logic correct and auditable | next |
| 3 | Case API with dev auth and tenant isolation | Do we keep the bank contract and reconstruct history truthfully | |
| 4 | Stuck-queue report and deadline sweeper | Do we find the money before the deadline does | |
| 5 | Performance evidence and SLOs | Does it hold at scale, measured | |

---

## Phase 0: Foundation — done

TypeScript, Hono, Zod, Pino, Vitest, PostgreSQL 17 in Docker. ESLint `strictTypeChecked` with layer
boundaries, Prettier, commitlint, husky hooks, `/healthz`, `/readyz`, `/metrics`, `/docs`.

Trimmed afterwards: the homemade guards, the second SQL linter and `db-check` were removed;
secret scanning moved to gitleaks (D-32).

---

## Phase 1: Schema and migrations — done

**Delivered**

- `migrations/0001` to `0010`: role, tenants, response windows, FX rates, cases, case events, rule
  config, and three indexes built `CONCURRENTLY`.
- Migration runner (`src/infrastructure/db/migrator.ts`, CLI `scripts/migrate.ts`): ordered files,
  SHA-256 checksums, advisory lock, `lock_timeout` for transactional migrations, per-migration
  transaction control, cleanup of a failed concurrent build, refusal to touch a non-empty database
  without a ledger. `npm run db:migrate` and `db:migrate:status`.
- [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md): the live-data plan the brief asks for.
- Tests on a throwaway database per run: runner behaviour, append-only enforcement, clocks, role
  privileges, response-window uniqueness.

**Exit criteria, met**

- An empty database is fully migrated with one command, and a second run applies nothing (also in
  CI).
- Every migration states its rollback or why it is irreversible.
- The no-transaction path is exercised by three `CONCURRENTLY` migrations.
- Downtime for the plan is stated: none planned, locks bounded by `lock_timeout`.

---

## Phase 2: Domain core

Pure TypeScript in `src/domain`, no database, no HTTP.

- `money.ts`: ISO 4217 exponents, `amount_minor` ↔ `amount_cents`, base-currency conversion with a
  snapshotted rate, no floating point on amounts.
- `deadline.ts`: end of day `presentment_date + window_days` in the window's zone; the single
  half-open `isWithinDeadline`.
- `events.ts`: the closed `CaseEvent` union with per-type metadata schemas and the 16 KB cap.
- `rules.ts`: the four rules, each returning status and `rule_key`; tenant order applied.
- `case.ts`: transition decision (`to` → event or rejection with the deciding rule); history fold.

**Exit criteria:** every rule tested at the boundary (exactly at the deadline, 1 ms before, 1 ms
after); the normal path "evidence in time, outcome after the deadline → WON" is a test; the history
fold is tested to ignore rule changes.

---

## Phase 3: Case API with dev auth

- `POST /cases`, `GET /cases/:id`, `GET /cases?external_ref=`, `POST /cases/:id/transitions`,
  `POST /cases/:id/notes`, `GET /cases/:id/history?as_of=`.
- One Zod schema per endpoint for validation, typing and OpenAPI.
- `amount_cents` accepted and returned alongside `amount_minor` and `currency_exponent`.
- Dev auth: locally minted HS256 tokens, refused when `NODE_ENV=production`; tenant and actor from
  the claims only.
- The application connects as a login role that is a member of `triple_app`.

**Exit criteria:** cURL examples in the README; cross-tenant read returns `404` and the test fails if
the tenant is read from anywhere but the claim; a 400-event case reconstructed event by event;
adding a response field keeps existing assertions green.

---

## Phase 4: Stuck-queue report and sweeper

- `GET /reports/stuck-queue` with `risk_window_days` (default 7), `deadline_state`, `LIMIT` and keyset
  pagination.
- `src/worker/sweeper.ts`: `OPEN` cases past their deadline, `FOR UPDATE SKIP LOCKED`, batch,
  idempotent, `system` actor, `SWEEP_INTERVAL_MS`.

**Exit criteria:** review scenarios 1 and 2 return the expected rows; two concurrent sweepers produce
one set of events; the report plan uses the partial index (`EXPLAIN`).

---

## Phase 5: Performance evidence and SLOs

- `scripts/seed-perf.ts`: 1M cases, realistic distribution, generated in SQL; one case with 400
  events. A `--rows` flag exists for anyone who wants 10M.
- `docs/PERFORMANCE.md`: `EXPLAIN (ANALYZE, BUFFERS)` for the report and history, and the scaling
  argument (TRADEOFFS §10).
- `docs/SLOS.md`: what pages someone at 3am (a breached deadline that was not at risk the day before,
  sweeper lag, a failed event write).

**Exit criteria:** scenario 3 under 200 ms and scenario 4 under 100 ms, measured; D-13 (no
partitioning) confirmed or reversed with numbers.

---

## Not in scope

A UI console, OIDC/JWKS, a rules admin API, outbound scheme integrations, evidence file storage,
voiding cases, retroactive deadline revisions, partitioning (until phase 5 says otherwise).
