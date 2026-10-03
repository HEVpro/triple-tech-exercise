# NOTES.md

How AI was used on this exercise, what it got wrong, and the reasoning behind every decision.

The exercise brief explicitly asks for the transcript of the agent that actually ran, and says it
values most "the prompts that failed and how you caught the bad output". This file is the honest
version of that: what was asked, what came back, and what had to be corrected by hand.

---

## 1. The working method

The AI was used as a **pair-programming adversary**, not as an autopilot. The pattern for every
decision was the same:

1. The AI was asked to present **options with trade-offs**, never to pick silently.
2. Options that the AI produced were checked against **verifiable facts** (package manifests, peer
   dependency ranges, database engine behaviour) rather than accepted on plausibility.
3. Where the AI hedged or produced a non-answer ("it depends", "one could argue"), it was pushed back
   on until it committed to one choice with a stated reason.
4. Every decision was recorded here with the reason, so a reviewer can disagree with the reasoning
   rather than having to reverse-engineer it.

The most valuable output of the AI was **not code**. It was the discovery of two defects in the
brief itself (D-4 and D-13) and of the npm/TypeScript incompatibility (D-15).

---

## 2. Prompts that failed, and how the bad output was caught

### 2.1 The brief's `amount_cents` is a domain defect

**What was asked:** design the `cases` table for the exercise brief.

**What came back:** a schema using `amount_cents BIGINT`.

**Why that is wrong:** the brief names the field `amount_cents`, but ISO 4217 currencies do not all
have two decimal places. JPY has zero, KWD has three. Storing 1000 JPY as `100000` in a column
called `amount_cents` is arithmetically meaningless, and a reviewer who knows payments will spot it
immediately.

**How it was caught:** walking the brief's own arithmetic. The brief defines `deadline_at =
presentment_date + window(scheme, reason_code)` and assumes integer minor units for money, but never
reconciles that with `currency`. Once the exponent question was raised, the defect became obvious.

**Correction:** D-4. The field is named `amount_minor`, the scale comes from a currency exponent map
in code, and the deviation from the brief is documented rather than silently absorbed.

### 2.2 Recommending `TypeScript 7` before checking peer ranges

**What was asked:** pick the TypeScript version and the linter stack.

**What came back:** an initial recommendation of the latest `typescript` (which is `7.0.2`, the
native Go port), on the reasonable grounds that it is the newest major.

**How it was caught:** before writing any code, the AI was asked to verify the compatibility of the
proposed linter. Running `npm view typescript-eslint peerDependencies` returned:

```
typescript-eslint@8.71.0
  peerDependencies: { eslint: "^8.57.0 || ^9.0.0 || ^10.0.0",
                      typescript: ">=4.8.4 <6.1.0" }
```

`typescript-eslint` — the only linter that provides type-aware rules — does not accept TypeScript 7.
Choosing the newest TypeScript would have silently downgraded the entire lint strategy.

**Correction:** D-15. Pinned `typescript@5.9.3`, the last 5.x stable, and the pin is exact rather
than a caret range so the constraint cannot drift.

### 2.3 Recommending `drizzle-kit` for migrations, which dragged in vulnerable transitive deps

**What was asked:** choose a migration tool.

**What came back:** `drizzle-kit` for generating and applying migrations.

**Why that was wrong:** `npm audit` reported four moderate-severity advisories, all originating
from `drizzle-kit` → `@esbuild-kit/esm-loader` → `esbuild <= 0.24.2`. Shipping a security exercise
with four moderate advisories in the dependency tree undermines the answer to any security question.

**Why the tool was unnecessary at all:** the migrations were already decided to be hand-written plain
SQL, because a regulator has to be able to read what runs against production without trusting the
application. A code generator is only needed to produce the SQL, and we deliberately want a human to
write it. A custom runner was already required by D-14 to support non-transactional migrations.

**Correction:** `drizzle-kit` removed. `drizzle-orm` stays for typed queries. `npm audit` now reports
zero vulnerabilities.

### 2.4 `npm install` crashing out of the box

**What happened:** on a clean `npm install`, npm 10.9.2 (bundled with Node 23) crashed with
`TypeError: Cannot read properties of null (reading 'edgesOut')` inside arborist's `#loadPeerSet`,
while resolving the optional peer set of `vitest@5`.

**How it was diagnosed:** the stack trace pointed at `idealTree/node_modules/vitest`, and inspecting
`vitest@5.0.3`'s manifest showed a large set of optional peers (`@vitest/browser`, `@vitest/ui`,
`webdriverio`, ...) that the buggy resolver mishandles.

**How it was solved so the reviewer is never blocked:** rather than requiring a specific npm version
or a different package manager, `.npmrc` is committed with `legacy-peer-deps=true` and a comment
explaining the upstream bug. A plain `npm install` works on a fresh machine with no flags.

A side effect of this is that peer dependencies are no longer auto-installed, which is how
`vite` went missing and Vitest failed to start. `vite` is therefore declared explicitly as a direct
dev dependency.

### 2.5 Two silent config bugs in the LLM-default-shaped setup

Both were caught only because `typecheck` and `lint` were run before anything else was trusted:

- **`console` ban misconfigured.** The `{ name, message }` object shape was applied to the
  `no-console` rule, which only accepts `{ allow: [...] }`. ESLint refused to load the config at all.
- **Vitest 5 moved `coverage`.** Root-level `coverage` is no longer part of Vitest 5's config type;
  it must sit under `test.coverage`. Root `test` and `test.coverage` are the only shapes that
  typecheck.

### 2.6 A git hook that looked like it worked and enforced nothing

**What happened:** the `pre-commit` hook was written with two commands on separate lines:

```sh
npx --no-install lint-staged
npx --no-install prettier --check "*.{json,md,yml,yaml}"
```

A shell script's exit status is the exit status of its *last* command. `prettier --check` passed, so
the hook exited 0 even when `lint-staged` had just failed. The output still showed a red `✖` and
`✖ Failed to run tasks for staged files!`, so the hook looked like it was blocking commits.

**Why this mattered more than it looks:** the ESLint gate and the credential scan are the two checks
a reviewer will assume are enforced. Both were silently bypassable. A commit containing a hardcoded
secret or a `console.log` would have gone straight through, and CI would not have caught the secret
either, because the secret scan only existed in the hook.

**Correction:** `set -e` at the top of the hook, and a single command. A hook is a gate, and a gate
must be tested by trying to get through it. Both cases are now verified: a staged secret exits 1, a
staged `console.log` exits 1, a clean tree exits 0. The credential scan was also promoted into CI so
that it does not depend on a local hook being installed at all.

### 2.7 Coverage thresholds that were failing before they were meaningful

`test:coverage` failed on the first honest run, at 73% lines against an 85% threshold. The tempting
fix is to lower the threshold. The useful fix was to ask which untested code actually mattered.

Untested was `pool.ts`, at zero, which is the database pool the entire platform runs on, and the
`/readyz` failure path. Those got real tests rather than a lowered bar. The one threshold that was
relaxed is `branches`, because most branches today are configuration paths, and it is recorded in the
README as a floor to raise rather than a target.

The integration tests skip themselves when PostgreSQL is unreachable, so `npm test` still works on a
fresh clone before `npm run db:up`, while CI runs a service container so they actually execute there.

### 2.8 The AI could not explain its own `as_of` design

**What happened:** the initial explanation of time travel was confident and plausible, but on being
questioned ("which clock do you use when evaluating the deadline rule?") it turned out the original
design evaluated rule 1 against `now()`.

That design is wrong, and it is wrong in the most damaging way possible: `as_of` would return
today's status for every historical timestamp, so the endpoint would claim to reconstruct history
while never actually doing it. Nothing in the type system or the tests would have caught it.

**Correction:** D-11. The replay clock is `as_of`, never `now()`. This is stated as an invariant in
the domain module and asserted in tests, because it is the kind of correctness that only shows up
when someone re-derives the reasoning.

### 2.9 Where the AI was right and the initial human framing was wrong

Recorded because a fair account of the transcript matters more than a flattering one.

- **`response_windows` is not scope creep.** It was initially treated as an addition. It is in fact a
  hard dependency of the brief's own rule 1, which cannot compute `deadline_at` without it.
- **Partitioning was initially assumed to be needed** for a 10M-row tenant. Analysis of the actual
  query set showed no hot query benefits from it (D-13), which is a better argument than "partition
  everything large".
- **The half-open interval** `[t0, deadline_at)` was adopted over `<=` after being shown that a
  closed interval makes a boundary event simultaneously in-window and out-of-window depending on
  which code path evaluates it.

---

## 3. Decision register

Each decision states the choice, the reason, and what was rejected.

| ID | Decision | Why | Rejected alternative |
| --- | --- | --- | --- |
| **D-1** | Single tenant as an explicit **working hypothesis**. `tenant_id` remains on every business table; `tenants` holds one seeded row; tenant is derived from the verified token claim exactly as it would be for 60 tenants. | Costs nothing in code, preserves the whole multi-tenant deliverable (the brief asks for a migration plan against "live data for 60+ tenants"), and can be turned on by seeding more rows. | Building full multi-tenant admin/isolation machinery for a hypothesis the exercise did not state. |
| **D-2** | Fixture profiles: `smoke` 200k for CI, **`full` 2M as the default**, `spec` 10M behind a flag. | 2M rows with a partial index already demonstrates the review scenario, and 10M (~6-7 GB) should not be the default on a developer laptop. | Generating 10M rows by default; and equally, proving the index on 200k rows and calling it done. |
| **D-3** | `response_windows` is effective-dated. The resolved window is **snapshotted onto the case** (`deadline_at`, `deadline_window_version`, `deadline_basis`). A retroactive regulator ruling is implemented as a versioned batch that appends `DEADLINE_REVISED` events. | Payment schemes judge a dispute under the rules in force at presentment, so the snapshot is the defensible default. Making the alternative a scripted, audited operation rather than a silent mutation means the default can be reversed safely. | Recomputing deadlines on every read from the current window: cheap, and it rewrites history, so `as_of` stops being reproducible. |
| **D-4** | `amount_minor BIGINT` + `currency CHAR(3)`, with an ISO 4217 exponent map in code. **Field renamed from `amount_cents`.** | `amount_cents` is a defect in the brief: JPY has 0 decimals, KWD has 3. `INT` would overflow at ~$21M, which a portfolio total can reach; `BIGINT` cannot overflow in this domain. | `double precision` (inexact), `NUMERIC` (exact but slower and unnecessary for integer minor units), and a fixed 2-decimal convention (breaks JPY and KWD). |
| **D-5** | Report normalisation materialises `amount_base_minor`, `base_currency`, `fx_rate`, `fx_rate_date` at case creation from a fixed, versioned, effective-dated FX table. | `ORDER BY amount` must mean something across currencies, and a report whose number changes daily cannot be audited or reproduced. Fixed contractual rates also match how banks provision chargeback exposure. | Live FX lookup at report time (non-reproducible, adds network latency to a sub-100ms query); grouping by currency only (does not answer "where are we losing money"). |
| **D-6** | `deadline_at` = end of `(presentment_date + window_days)` **in the tenant's IANA timezone**, computed with `DATE` arithmetic and then localised. In-window test is the half-open interval `event_at < deadline_at`. | The scheme deadline is anchored to the bank's calendar day, not to Greenwich. `DATE` arithmetic plus `AT TIME ZONE` is DST-safe, where `TIMESTAMPTZ + interval '45 days'` silently shifts on a 23h or 25h day. A half-open interval removes boundary ambiguity entirely. | UTC-only arithmetic (grants up to 14 extra hours); storing only a `DATE` (loses hour/minute precision the operations team needs). |
| **D-7** | `actor_type IN ('human','agent','system')`, and `actor_id` is always populated. | The sweeper is not a human and not an agent. An audit trail without an identity is decoration. | The brief's two-value enum, which cannot express the automated transition that rule 1 requires. |
| **D-8** | Terminal rule **predicates are TypeScript functions**; `tenant_rule_config` holds only enablement and priority per tenant. No admin API in v1; config changes go through migrations. | The dangerous part of a rules engine is text that gets evaluated, which implies an admin surface that can be injected into or used for privilege escalation. The genuinely useful part is ordering and per-tenant override, which is plain data. | Fully table-driven predicates in a DSL or SQL (unauditable, untestable, an attack surface), and fully config-in-code (cannot be tuned without a deploy). |
| **D-9** | Periodic batch sweeper, `SWEEP_INTERVAL_MS` default 60000, `FOR UPDATE SKIP LOCKED`, idempotent, `system` actor. The stuck-queue report exposes a computed `overdue` flag. | Rule 1 is time-triggered, and a case sitting in `OPEN` generates no event when the clock passes its deadline. Without an actor the stored status becomes a lie and the at-risk backlog only grows. Idempotency comes free because the events are the truth and the status is a projection. | Lazy evaluation on read (re-computes on every read, and the stored status still lies to every other consumer); `pg_cron` (domain logic in SQL, not unit-testable). |
| **D-10** | `case_events.metadata JSONB NOT NULL DEFAULT '{}'`, validated per `event_type` by a `z.discriminatedUnion`, capped at 16 KB, no PII, `ON DELETE CASCADE` from `cases`. | Adding attributes to an event must not require a migration across 60 tenants. Typed columns are kept for everything that is queried, so JSONB is payload only. The closed union turns "append-only" from a convention into a type. | Free-form unvalidated JSONB (silently accepts typos, makes the audit trail undemonstrable); indexing into JSONB at 10M rows (unusable); storing PII (append-only vs. erasure becomes unresolvable). |
| **D-11** | `as_of` replays events with `occurred_at <= as_of` ordered by `(occurred_at, seq)`, evaluating the rules with **`clock = as_of`**, capped at 50 000 events with an explicit `truncated` flag. Returns the reconstructed case, the status, and the rule that produced it. | Moving the clock is what makes the endpoint actually reconstruct; using `now()` would return today's status for every historical instant. `seq` makes timestamp ties deterministic. Returning the whole case means a future `CASE_AMENDED` event needs no API change. | Evaluating the deadline rule against `now()`; returning only the status (no explainability, no forward compatibility). |
| **D-12** | JWT verified locally with `jose` against a JWKS. Tenant identity is taken **only** from the verified claim. `AUTH_MODE=dev` mints HS256 tokens locally and that endpoint refuses to run when `NODE_ENV=production`. | A tenant taken from a header or body is a cross-tenant data leak waiting to happen. The claim is the security property that makes D-1 safe to reverse. | Dev headers for tenant identity (they look harmless and they are not); a full IdP integration for the exercise (adds setup cost without testing the domain). |
| **D-13** | **No partitioning.** The decision is deferred to evidence: `EXPLAIN (ANALYZE, BUFFERS)` plus vacuum/bloat analysis on the 2M-row fixture. Triggers to revisit are recorded. | No hot query is helped: all are tenant-scoped and index-backed. Partitioning does not assist point lookups or per-tenant scans; it only helps time-based deletion and very large global aggregates. It is a premature optimisation and costs 60x the DDL objects. | Partitioning by `presentment_date` up front, which is the reflexive choice for a large table. |
| **D-14** | The migration runner must support **per-migration transaction control**. | `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. Without this, production indexes must be created by hand outside the migration system, losing traceability on exactly the artefact the brief asks to be auditable. | A runner that wraps every migration in a transaction, which would make the required production index strategy impossible. |
| **D-15** | `typescript@5.9.3`, pinned exactly. Not 7.x. | `typescript-eslint@8.71.0` declares `typescript: ">=4.8.4 <6.1.0"`. TypeScript 7 is incompatible with the only type-aware linter in the stack. | `typescript@latest` (7.0.2), which was the first recommendation and would have silently downgraded the lint strategy. |
| **D-16** | ESLint 10 flat config with `typescript-eslint` **strictTypeChecked**, plus `no-restricted-imports` enforcing layer boundaries, plus `eslint-plugin-perfectionist` for deterministic ordering. | Type-aware rules catch real defects (`no-floating-promises`, `no-unnecessary-condition`), not style. The layer rules make `src/domain` physically unable to import `pg`, which is what keeps the domain testable without infrastructure. Deterministic ordering keeps diffs reviewable, and reviewable history is an explicit deliverable. | ESLint without type information; a framework that enforces layering by convention only. |
| **D-17** | `console` is banned by two ESLint rules (`no-console`, `no-restricted-globals`) **and** independently by `npm run guard:console`, which greps `src/`. `src/` logs through `pino`; scripts write to `process.stdout`. The guard runs in `pre-push` and CI, so it does not depend on a hook being installed. | Required explicitly, and cheap to enforce reliably when it is duplicated. The grep also survives an inline `eslint-disable`, which the rule cannot. | Relying on reviewers to notice `console.log`. |
| **D-18** | `pino` with redacted `authorization` and `cookie` headers, `pino-pretty` only in development, request id propagated per request. | Structured logs with secrets redacted, and human-readable local logs without shipping a dev transport to production. | `console.log`, per D-17. |
| **D-19** | `pre-commit` runs only on staged files (prettier, eslint --fix, credential scan) and is `set -e` with a single command. `pre-push` and CI run the real gates: guard, typecheck, lint, test, coverage, build. | A fast commit keeps the hook usable; a slow, strict gate belongs where nobody can skip it. The `set -e` is not cosmetic: see 2.6, where a two-command hook silently disabled the whole commit gate. | Putting `tsc --noEmit` on every commit, which is slow enough that people bypass hooks. |
| **D-20** | `commitlint` with conventional commits. | The brief asks for the history to be left intact, which makes commit messages part of the deliverable. | Unvalidated messages, which make `git log` unreadable as evidence. |
| **D-21** | `postgres:17-alpine`, container name `triple-postgres`, port 5433, healthcheck, named volume, and a matching service container in CI. | PostgreSQL 17 is the current LTS-adjacent choice a bank would run. Port 5433 avoids colliding with a Postgres the reviewer may already have locally. The CI service container means the integration tests actually run rather than silently skipping. | The locally cached 16-alpine image (older, and pinning the project to whatever happens to be cached is not a reason). |
| **D-22** | `SWEEP_INTERVAL_MS` defaults to 60000 and is configurable. | The latency between a real deadline and a recorded status must be bounded, measurable and alertable, which is exactly the SLO in the brief's bonus section. | A hardcoded interval, or running the sweeper on every request. |
| **D-23** | SQL is linted twice: `npm run lint:sql` runs **sqlfluff inside Docker**, and `npm run lint:sql:node` runs a pure-Node syntax and formatting check. Neither is in the mandatory gate path. **Python is never required.** | Migrations and the report query are the two artefacts a reviewer reads by eye, so consistent formatting and semantic rules are worth having. Docker is already a prerequisite for Postgres, so adding a container changes nothing about the setup burden, and the Node fallback means the gate never needs Python. | `sqlfluff` via `pipx` or a Python venv, which makes a fresh clone fail on a machine without Python. That is unacceptable for a technical exercise. |
| **D-24** | Prettier is the single formatter for SQL; sqlfluff's layout rule family (`LT01`-`LT14`) is excluded so the two tools cannot fight. | Two formatters disagreeing about indentation produces a repository where `npm run format` and `npm run lint:sql` contradict each other, which trains reviewers to ignore both. | Letting both enforce layout. |

---

## 4. What is deliberately unfinished at this stage

Phase 0 delivers the repository, the toolchain and the database container. Recorded here so the gaps
are explicit rather than discovered by a reviewer:

- **Phases 1 to 6 are specified but not implemented.** The roadmap, the deliverables per phase and the
  exit criteria are in [`docs/PHASES.md`](./docs/PHASES.md).
- The domain model, the state machine, the entity set, the flows and the ten invariants are written
  out in [`docs/DOMAIN.md`](./docs/DOMAIN.md). None of it is code yet: `src/domain` and
  `src/application` are empty directories.
- The trade-offs behind each review scenario, with what each choice costs and what would reverse it,
  are in [`docs/TRADEOFFS.md`](./docs/TRADEOFFS.md). Three deliberate deviations from the brief are
  listed there in section 13 so they are decisions rather than oversights.
- **No performance number in this repository is measured yet.** The 200 ms history and 100 ms report
  targets are phase 6 deliverables, with `EXPLAIN (ANALYZE, BUFFERS)` output attached. Until that
  exists they are intentions, not claims.
- Migrations are specified (`migrations/README.md`) but the runner arrives in phase 1, together with
  the non-transactional support required by D-14. `npm run db:migrate` is therefore wired up but not
  yet runnable.
- The layer boundaries in D-16 are already enforced, so the first file added to `src/domain` is checked
  against them.
- Authentication, the case endpoints and the sweeper are not implemented. `src/http/app.ts` currently
  serves only `/healthz`, `/readyz`, `/metrics` and `/docs`.
- The `guards` are pattern matchers, not a full secret scanner. They cover the common cases and are a
  backstop for carelessness; they are not a substitute for a reviewer reading the diff.