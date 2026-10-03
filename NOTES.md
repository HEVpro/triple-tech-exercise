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

The most valuable output of the AI was **not code**. It was the discovery of defects in the brief
itself (D-4, and rule 1 in 2.10) and of the npm/TypeScript incompatibility (D-15). The most valuable
output of the human was the repeated question "what is the use case?", which removed a good deal of
the AI's over-engineering (2.13).

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

*Later:* the homemade regex scanner was replaced by gitleaks in CI over the full history, and the
`console` grep by ESLint's `noInlineConfig` (D-17, D-32). The lesson about testing gates stands.

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

*Superseded by 2.11:* the clock fix was necessary but not sufficient.

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

### 2.10 Rule 1, as designed, would have auto-lost cases that answered in time

**What came back:** the terminal rules transcribed in brief order, with rule 1 ("deadline passed →
LOST") placed first "so that a loss is never erased", and a sweeper selecting `OPEN` *and*
`UNDER_REVIEW` cases past their deadline.

**How it was caught:** a design review that walked the normal path rather than the edge cases. A bank
files evidence on day 20; the scheme decides on day 70. On day 46 the sweeper would have marked the
case `LOST`, and when the scheme's `WON` arrived, rule 1 would still have beaten rule 3. A second
defect sat next to it: with first-match evaluation, rule 2 ("evidence filed") always matches before
rule 3, so `WON` was unreachable.

**Correction:** rule 1 is "deadline passed **without evidence filed before it**", rule 2 also requires
"no outcome yet", `WON`/`LOST` are absorbing, and the sweeper only looks at `OPEN`. Listed as a
deviation from the brief's literal wording in TRADEOFFS §14.

### 2.11 The fix for 2.8 was itself incomplete

Moving the replay clock to `as_of` fixed the deadline, but the replay still **re-evaluated the rules**
on every read. Rules are configurable per tenant and live in code, so reordering a tenant's rules or
fixing a predicate would have changed what the system says about the past.

**Correction:** D-11 revised. Rules run on write only; each event stores `to_status`, `rule_key` and
`ruleset_version`; history folds stored values. The lesson recorded: a fix that survives one
"why?" may not survive the second one.

### 2.12 The API design broke the brief's own contract

**What came back:** `GET /v1/cases/:external_ref`, and `amount_cents` renamed to `amount_minor` in
the API.

**How it was caught:** re-reading one sentence of the brief: *"Banks consume `GET /cases/:id`, so keep
it working."* Both the path and the field rename are breaking changes for an integrated bank, which
is exactly what the brief says it values.

**Correction:** D-27. Unversioned `/cases/:id`; the database column is `amount_minor`, the API accepts
and returns `amount_cents` as well.

### 2.13 Over-engineering, caught by asking "what is the use case?"

The AI proposed, at different points: effective-dated response windows with an `EXCLUDE` constraint
and `btree_gist`; a batched backfill of an invented legacy database; three fixture profiles with 10M
rows as a target; seven delivery phases; OIDC against a real JWKS; two SQL linters; three homemade
repository guards.

Each one was defensible in isolation. Each one fell when the human asked what concrete case it served
in *this* exercise. The replacements are smaller and say what they give up: a two-column unique key
(D-3), live-safe greenfield migrations plus a written plan (D-34), one 1M fixture plus a written
scaling argument (D-2), six phases (D-35), dev tokens, sqlfluff only, gitleaks (D-32).

### 2.14 A documented guarantee that was not true

The README and D-24 stated that "Prettier is the single formatter for SQL". It never was:
`.prettierignore` excluded `*.sql` and no SQL plugin was installed, so the SQL override in
`.prettierrc.json` was dead configuration. Caught while reviewing whether `scripts/` was needed at
all. sqlfluff now owns SQL layout explicitly.

### 2.15 Whose time zone is the deadline in?

The first design anchored deadlines to the tenant's time zone. The human asked what happens with
payments made all over the world. The answer reframed the question: the cardholder's and merchant's
locations are irrelevant; the obligation is between the issuer and the scheme, so the scheme's
calendar anchors it. D-6 revised to a per-window zone, `UTC` by default. The AI also stated plainly
that it had **not verified** each scheme's rulebook, so UTC is recorded as an assumption to confirm,
not as a fact.

---

## 3. Decision register

Each decision states the choice, the reason, and what was rejected. **(rev.)** marks a decision
revised during the design review recorded in 2.10 to 2.15; the earlier version is described in the
rejected column.

| ID | Decision | Why | Rejected alternative |
| --- | --- | --- | --- |
| **D-1** | Single tenant as an explicit **working hypothesis**. `tenant_id` on every business table; tenant taken only from the verified token. | Costs nothing, keeps the 60+ tenant target shape, enabled by seeding rows. | Tenant administration machinery for a hypothesis the brief does not state. |
| **D-2** (rev.) | One performance fixture of **1M cases** with a realistic distribution, generated in SQL; a `--rows` flag for 10M. The scaling argument is written down (TRADEOFFS §10). | Report latency depends on the at-risk set size and on the index fitting in memory, not on total rows; a B-tree is 3–4 levels deep at both 1M and 10M. | Three profiles (200k / 2M / 10M) with 10M as the target, which costs a laptop 6–7 GB to prove something the argument already explains. |
| **D-3** (rev.) | `response_windows(scheme, reason_code NULL, window_days, deadline_tz)`, `UNIQUE NULLS NOT DISTINCT (scheme, reason_code)`, changed by migration. The window is **snapshotted onto the case**. | Satisfies `window(scheme, reason_code)` and "windows are data". The snapshot means a reissued window never moves a live deadline. | Effective-dated rows with `EXCLUDE` over date ranges and `btree_gist`: served only late registration across a rule change. `DEADLINE_REVISED` batches are reserved, not built. |
| **D-4** (rev.) | `amount_minor BIGINT` + `currency CHAR(3)` in the database, ISO 4217 exponent map in code. **The API still accepts and returns `amount_cents`**, plus `amount_minor` and `currency_exponent`. | `amount_cents` is wrong for JPY and KWD, but it is the brief's field and banks consume it. Fixing the model must not break the contract. | Renaming the API field (breaking, 2.12); `double precision`; `NUMERIC`; a fixed two-decimal convention. |
| **D-5** (rev.) | Static `fx_rates(currency, base_currency, rate, rate_date)`; `amount_base_minor`, `fx_rate`, `fx_rate_date` snapshotted at creation. | The report must order by money across currencies, reproducibly. | Live FX at report time. Production would source rates from scheme settlement or the bank's provisioning rates (TRADEOFFS §15). |
| **D-6** (rev.) | `deadline_at` = end of day `presentment_date + window_days` in the **window's** zone (`deadline_tz`, default `UTC`). Half-open `instant < deadline_at`. | The obligation is issuer ↔ scheme, so the scheme's calendar anchors it; UTC removes DST; half-open gives a boundary one answer. UTC is an unverified assumption per scheme. | The tenant's time zone (2.15); `timestamptz + interval`; a closed interval. |
| **D-7** | `actor_type IN ('human','agent','system')`, `actor_id` always set; from the token (user → `human`, machine client → `agent`); `system` only for `DEADLINE_EXPIRED`, enforced by a `CHECK`. | An automatic loss needs an honest actor; the API must not let a client claim to be the system. | The brief's two-value enum. |
| **D-8** | Rule **predicates in TypeScript**; `tenant_rule_config` holds `enabled` and `priority`. No admin API; changes by migration. | Evaluated text in a table is an attack surface and untestable; order and enablement are data. With corrected predicates, order only decides rule 1 vs rule 3. | Predicates as SQL or a DSL; everything hardcoded. |
| **D-9** (rev.) | Periodic sweeper over **`OPEN` only**, `FOR UPDATE SKIP LOCKED`, batch, idempotent, `system` actor. | `UNDER_REVIEW` filed evidence in time and cannot lose to the deadline (2.10). | Sweeping `UNDER_REVIEW` too; lazy evaluation on read; `pg_cron`. |
| **D-10** (rev.) | `case_events` append-only by **grants** (`triple_app`: `SELECT`, `INSERT`), a **trigger** rejecting `UPDATE`/`DELETE`/`TRUNCATE` for every role, and **`ON DELETE RESTRICT`** to `cases`. `metadata JSONB` validated per type, ≤ 16 KB, no personal data. A future "delete" is a `CASE_VOIDED` event. | Audit that a single SQL statement can erase is not audit. | `ON DELETE CASCADE` (deleting a case erased its trail); convention only. |
| **D-11** (rev.) | **Rules run on write only.** Events store `to_status`, `rule_key`, `ruleset_version`. History folds events with `recorded_at <= as_of` by `seq`, never evaluating a rule. 50 000-event cap with `truncated`. | The past must not depend on today's code or config (2.11). | Re-evaluating rules on read with `clock = as_of`; with `now()` (2.8). |
| **D-12** (rev.) | v1 auth: locally minted HS256 tokens, refused in production; tenant and actor from claims only. | Tests tenant isolation without IdP setup. | OIDC/JWKS in v1 (deferred, TRADEOFFS §15); identity from headers. |
| **D-13** | **No partitioning.** Revisit on phase 5 evidence. | No hot query benefits; all are tenant-scoped and index-backed. | Partitioning up front. |
| **D-14** | The migration runner supports **per-migration transaction control** (`-- migrate:no-transaction`, one statement per file). | `CREATE INDEX CONCURRENTLY` cannot run in a transaction and must stay in the migration system. | Wrapping every migration in a transaction. |
| **D-15** | `typescript@5.9.3`, pinned exactly. | `typescript-eslint@8.71.0` requires `<6.1.0`. | `typescript@latest` (7.0.2). |
| **D-16** | ESLint 10 flat config, `strictTypeChecked`, layer boundaries via `no-restricted-imports`, `perfectionist` ordering. | Type-aware rules catch defects; the domain cannot import infrastructure. | ESLint without types; layering by convention. |
| **D-17** (rev.) | `console` banned by ESLint (`no-console`, `no-restricted-globals`) with **`linterOptions.noInlineConfig: true`**, so no source file can switch a rule off. | Same guarantee as the old grep guard, enforced in one place. | A separate grep script duplicating ESLint. |
| **D-18** | `pino` with redacted credentials, `pino-pretty` only in development. | Structured, safe logs. | `console.log`. |
| **D-19** (rev.) | `pre-commit`: lint-staged (ESLint and Prettier on staged files). `pre-push` and CI: typecheck, lint, tests, build. Both `set -e`. | Fast commits, strict gates where they cannot be skipped. | `tsc` on every commit. |
| **D-20** | Conventional commits via commitlint. | The history is a deliverable. | Unvalidated messages. |
| **D-21** | `postgres:17-alpine`, port 5433, healthcheck, data checksums, CI service container. | Current version; no clash with a local PostgreSQL; integration tests really run in CI. | A cached 16-alpine image. |
| **D-22** | `SWEEP_INTERVAL_MS`, default 60 000, configurable. | Sweep lag is an SLO. | A hardcoded interval. |
| **D-23** (rev.) | **sqlfluff 4.4.0 in Docker is the only SQL linter**, layout rules included; `RF04` excluded for `name`/`version`. | One tool, no Python, pinned. | A second pure-Node SQL checker. |
| **D-24** (rev.) | Prettier does not touch SQL. | It never did (2.14); saying so is the fix. | Claiming Prettier formats SQL. |
| **D-25** | `POST /cases/:id/transitions { to }` maps `to` to a domain fact; the rules decide; a mismatch is `409` naming the rule; same status is a no-op `200`. | Keeps the brief's vocabulary while `UNDER_REVIEW` keeps its meaning: evidence filed in time. | Clients setting any allowed status. |
| **D-26** | `seq` = new `cases.version`, taken in the projection `UPDATE`; primary key `(case_id, seq)`. | Concurrency-safe via the row lock, gapless (a gap reveals tampering), and it is the history index. | `MAX(seq)+1`, a global identity, timestamps. |
| **D-27** | Unversioned paths (`/cases/:id`), additive-only responses, lookup by `?external_ref=`. | "Banks consume `GET /cases/:id`, so keep it working" (2.12). | `/v1/cases/:external_ref`. |
| **D-28** | Rules evaluated **at creation** too; the report returns `at_risk`, `responded` and recently `breached` rows with `deadline_state`. | Scenario 2 becomes deterministic, and lost money stays visible. | Waiting for the sweeper; hiding breaches from the report. |
| **D-29** | Creation idempotent on `UNIQUE (tenant_id, external_ref)`: same payload → `200` with the case, different → `409`. | The natural key already prevents duplicates; no key table needed. | An `Idempotency-Key` store. |
| **D-30** | Event catalogue v1: `CASE_CREATED`, `EVIDENCE_FILED`, `SCHEME_OUTCOME_RECORDED`, `DEADLINE_EXPIRED`, `NOTE_ADDED`. `NOTE_ADDED` exists so the trail shows the work, not just the status, and makes a 400-event case realistic. | A closed set, enforced by `CHECK` and by the type union. | Free-form event types. |
| **D-31** | `recorded_at` = database `now()`, forced by trigger; clients cannot send `occurred_at`; only `DEADLINE_EXPIRED` carries `occurred_at = deadline_at`. | One clock; no backdating. | Application timestamps; client-supplied event times. |
| **D-32** | Secret scanning with **gitleaks v8.30.1 in Docker** over the full history, in CI and as `npm run scan:secrets`. | A maintained scanner instead of 130 lines of local regexes. | The homemade guard script. |
| **D-33** | Runner: SHA-256 checksums, advisory lock, `lock_timeout = 5s` set by the runner, invalid-index check after no-transaction migrations, forward only. | Safe and auditable against live traffic. | `drizzle-kit` (vulnerable deps, 2.3); a `down` command that nobody tests. |
| **D-34** | Greenfield schema with **live-safe migrations**, plus a written rollout plan for 60+ tenants (`docs/MIGRATION_PLAN.md`). No invented legacy import. | What the brief asks is that our migrations can run on live data. | Modelling and backfilling a hypothetical legacy database (2.13). |
| **D-35** | Scope: six phases (0–5); no console, no OIDC, no rules admin API, no voiding, no retroactive revisions. | The brief values a working result over breadth. | Seven phases with a console and full auth. |

---

## 4. What is deliberately unfinished at this stage

Phases 0 and 1 are complete. Recorded so the gaps are explicit rather than discovered by a reviewer:

- **No domain code, no case API, no report, no sweeper yet.** They are phases 2 to 4 in
  [`docs/PHASES.md`](./docs/PHASES.md). `src/domain`, `src/application` and `src/worker` are empty.
- **The schema is real and tested**: append-only enforcement, the database clock, role privileges and
  the runner are covered by `test/schema.integration.test.ts` against a throwaway database.
- **No performance number is measured yet.** The 200 ms and 100 ms targets are phase 5 deliverables;
  until then they are intentions.
- **`deadline_tz = 'UTC'` is an assumption** to confirm against each scheme's rulebook.
- **The FX table is a placeholder** for the exercise (TRADEOFFS §15).
- The application still connects as the database owner locally. Phase 3 switches it to a login role
  that is a member of `triple_app`; the privilege tests already use `SET ROLE triple_app`.
- `TENANT_*` environment variables remain from phase 0 and will become a dev seed in phase 3.
