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
npm run db:migrate       # apply migrations (as the owner, MIGRATION_DATABASE_URL)
npm run dev:seed         # API role triple_api + demo tenants acme (EUR), globex (USD)
npm run dev:token        # print a dev bearer token
npm run db:generate      # migration from a change to src/infrastructure/db/schema
npm run db:schema:check  # fails if the schema changed without a migration
npm run typecheck
npm run lint             # zero warnings
npm test                 # DB tests skip themselves if PostgreSQL is down
npm run test:coverage
npm run lint:sql         # sqlfluff in Docker
npm run format
```

A change is done when `typecheck`, `lint`, `test:coverage`, `format:check` and, if the schema or
SQL changed, `db:schema:check` and `lint:sql` pass.

## Layers

```
src/domain          pure logic in blocks (see Domain structure); no I/O, no clock (ESLint-enforced)
src/application     use cases, one transaction each; depends on domain and on ports (ports.ts),
                    never on infrastructure (ESLint-enforced)
src/infrastructure  Drizzle schema (db/schema), the CaseStore adapter (db/case-store.ts), pool,
                    migration runner
src/http            routes, request/response schemas (drizzle-zod + @hono/zod-openapi), auth,
                    error envelope
src/worker          deadline sweeper
scripts/            CLIs only: migrate, dev-seed, dev-token (+ dev-tenants), seed-perf. Nothing else.
```

The domain receives `now` as an argument. It never reads a clock.

## Domain structure

`src/domain` is split into **blocks**, one folder per business concept. Every file inside a block
has a fixed role, so you know where something lives before opening anything.

```
src/domain/
  shared/     the common vocabulary: CaseStatus, Actor. Depends on nothing.
  money/      minor units, ISO 4217 exponents, conversion to the base currency
  deadline/   calendar and time-zone arithmetic (calendar.ts) and the deadline rule (deadline.ts)
  rules/      the terminal rules, their evaluation, and a tenant's order
  events/     the event catalogue, metadata schemas (Zod), validation
  dispute/    the dispute-case aggregate: create, transition, sweep, note, history
```

**File roles inside a block**

| File | Contains | Never contains |
| --- | --- | --- |
| `types.ts` | `interface` and `type` only | runtime code |
| `constants.ts` | data and public constants (tables, catalogues, limits, versions) | logic |
| `schemas.ts` | Zod schemas; exists only in `events/` | business decisions |
| `errors.ts` | the block's error classes | — |
| `<action>.ts` | one responsibility, named for what it does (`convert.ts`, `transition.ts`) | types or constants other files need |
| `index.ts` | the block's public API, re-exports only, with a 3–5 line header saying what the block is | logic |

- Create a role file only when it has content. A block with one small file stays one file plus its
  `index.ts`; do not add empty files for symmetry.
- A constant used by a single function may stay private next to it; anything shared or public
  goes in `constants.ts`.
- Tests mirror the structure: `test/domain/<block>/<file>.test.ts`, importing from the block's
  `index.ts` only. Shared test data lives in `test/domain/<block>/fixtures.ts`.

**Dependency direction** (one way only, enforced by ESLint):

```
shared  <-  money, deadline  <-  rules  <-  events  <-  dispute
```

**What ESLint enforces** (`eslint.config.js`, section "Domain architecture"):

1. Outside a block, only its `index.ts` may be imported, from inside or outside `src/domain`.
2. A block may only import the blocks listed for it in `DOMAIN_BLOCK_DEPENDENCIES`.
3. Zod is only allowed in `events/`.
4. No clock reads (`new Date()`, `Date.now()`) and no `Math.random()` anywhere in `src/domain`.
5. No infrastructure, HTTP, I/O or outer layers anywhere in `src/domain`.

**Adding a block:** create the folder with an `index.ts`, add one line to
`DOMAIN_BLOCK_DEPENDENCIES` listing what it may import, and add it to the tree above.

## Libraries before custom code

The stack was chosen to be used: Hono (and its helpers, e.g. `hono/jwt`), `@hono/zod-openapi`, Zod,
Drizzle ORM, drizzle-zod, drizzle-kit, pg, Pino, Vitest. **Do not reinvent what they already do.**

Before writing custom infrastructure (a runner, a validator, a query helper, an auth check):

1. **Check the library first**, in its current documentation (Context7) *and* in its installed
   source when behaviour matters. Documentation describes intent; the source decides.
2. **Write down the gap precisely**: which capability is missing, verified how (file and function).
3. **Build only that gap**, as a thin layer on top of the library, and record it in the decision
   register with the evidence. "It was easy to write" is not a reason.
4. **If the gap closes in a later version**, delete the custom code.

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
- **Never write a table change in SQL by hand.** Change `src/infrastructure/db/schema`, run
  `npm run db:generate`, review the SQL. Hand-written SQL is only for what drizzle-kit cannot
  express, via `npm run db:generate:custom`.
- **Never query with raw SQL when Drizzle can express it.** `sql` fragments are for what the query
  builder lacks (`now()`, `NULLS LAST`, `version + 1`).
- **No `console`** in `src/`; use `logger()` from `src/logger.ts`. Inline `eslint-disable` is ignored
  by config.

## Vocabulary

| Use | Not |
| --- | --- |
| `amount_minor` (DB, domain) | `amount_cents` except at the API boundary |
| `recorded_at` / `occurred_at` | `created_at` on events, `timestamp` |
| `rule_key`: `deadline_passed`, `evidence_filed`, `scheme_outcome`, `default_open` | rule numbers in code |
| `deadline_state`: `at_risk`, `responded`, `breached` | `overdue` |
| `error.code` from the fixed list in `src/http/errors.ts` | free-text error strings |

## Conventions

- **Never commit or push unless the user explicitly asks for it in that moment.** Finish the work,
  run the gates, show the diff summary, and wait. A previous "commit" instruction does not carry
  over to later changes.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:` …), enforced by commitlint.

## Commits

The history is a deliverable: a reviewer should be able to read how the system was built, commit by
commit. Phases 0–2 were committed one commit per phase and are left as they are (NOTES 2.19); from
phase 3 on, every commit is atomic.

**One logical change per commit, and every commit leaves the repository green.**

- **Title:** what changes, imperative, scoped, at most 72 characters, understandable without the
  diff. `feat(domain): compute scheme deadlines with a half-open window`, not
  `feat(domain): phase 2`.
- **Body:** why, the alternative rejected if there was one, and the reference (`D-xx`,
  `NOTES 2.x`). Not a list of files; git already has that.
- **Tests go in the same commit as the code they test; docs in the same commit as the change they
  describe.**
- **If the title needs an "and", or the body a list of topics, it is two commits.**
- Never rewrite pushed history.

**Workflow**

1. Work through the phase in slices without committing.
2. Present a **commit plan**: the ordered list of commits, each with its title and files.
3. The user approves or edits the plan once.
4. Create the commits in that order, staging by file (or by building each slice in order).
5. Verify every commit on its own before reporting:

   ```bash
   git rebase --exec "npm run typecheck && npm run lint && npm test" origin/main
   ```

   This replays the unpushed commits and runs the gates at each one; it stops at the first commit
   that is not green. Unchanged commits keep their hashes.
6. Report the result. The user pushes.
- Tests that need PostgreSQL create a throwaway database (`test/support/temp-database.ts`); never
  write to the developer's database from a test.
- Prefer deleting code to adding configuration. If a tool or file has no clear use case, it does not
  belong in the repository.
