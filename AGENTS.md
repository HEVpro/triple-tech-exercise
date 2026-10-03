# AGENTS.md

Instructions for coding agents working in this repository. Humans should start with the README.

## What this is

A dispute-case service for an issuer's chargeback team: TypeScript, Hono, Zod, PostgreSQL 17. The
brief is [`technical-exercise.md`](./technical-exercise.md). Before changing behaviour, read:

- [`docs/DOMAIN.md`](./docs/DOMAIN.md) — states, rules, clocks, entities, API contract, invariants.
- [`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md) — why each decision was made and what was rejected.
- [`docs/PHASES.md`](./docs/PHASES.md) — what is done and what comes next.
- [`NOTES.md`](./NOTES.md) section 3 — the decision register (`D-n`).

If a change contradicts a decision, say so and update the register; do not silently diverge.

## Commands

```bash
npm run db:up            # PostgreSQL in Docker on port 5433
npm run db:migrate       # apply migrations
npm run typecheck
npm run lint             # zero warnings
npm test                 # DB tests skip themselves if PostgreSQL is down
npm run test:coverage
npm run lint:sql         # sqlfluff in Docker
npm run format
```

A change is done when `typecheck`, `lint`, `test:coverage`, `format:check` and, if SQL changed,
`lint:sql` pass.

## Layers

```
src/domain          pure logic; no pg, hono, pino, node:*, I/O or clock reads (ESLint-enforced)
src/application     use cases; depends on domain and ports
src/infrastructure  PostgreSQL, migrations runner
src/http            routes, schemas, auth, error mapping
src/worker          deadline sweeper
scripts/            CLIs only: migrate.ts, seed-perf.ts. Nothing else belongs here.
```

The domain receives `now` as an argument. It never reads a clock.

## Non-negotiables

- **Never update or delete `case_events`.** The database rejects it; do not work around it.
- **Never evaluate rules when reading history.** History folds stored `to_status` values.
- **Never generate audit timestamps in the application.** `recorded_at` is the database clock.
- **Never accept tenant or actor from a header, body or query parameter.** Only from the verified
  token.
- **Never use floating point for money.** Integer minor units plus currency.
- **Every write to `cases` writes an event in the same transaction**, with `seq = cases.version`.
- **The API is additive only.** Do not rename or remove a response field; `amount_cents` stays.
- **Never edit an applied migration.** Add a new one. Follow [`migrations/README.md`](./migrations/README.md).
- **No `console`** in `src/`; use `logger()` from `src/logger.ts`. Inline `eslint-disable` is ignored
  by config.

## Vocabulary

| Use | Not |
| --- | --- |
| `amount_minor` (DB, domain) | `amount_cents` except at the API boundary |
| `recorded_at` / `occurred_at` | `created_at` on events, `timestamp` |
| `rule_key`: `deadline_passed`, `evidence_filed`, `scheme_outcome`, `default_open` | rule numbers in code |
| `deadline_state`: `at_risk`, `responded`, `breached` | `overdue` |

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:` …), enforced by commitlint.
- Tests that need PostgreSQL create a throwaway database (`test/support/temp-database.ts`); never
  write to the developer's database from a test.
- Prefer deleting code to adding configuration. If a tool or file has no clear use case, it does not
  belong in the repository.
