# NOTES.md

How AI was used on this exercise, what it got wrong, and the reasoning behind every decision.

The exercise brief explicitly asks for the transcript of the agent that actually ran, and says it
values most "the prompts that failed and how you caught the bad output". This file is the honest
version of that: what was asked, what came back, and what had to be corrected by hand.

**The transcript itself is in [`docs/transcript.md`](./docs/transcript.md)**: every prompt and every
answer of the session, in order, with one line per action the agent took.
It was exported from the Claude Code session and converted to Markdown; tool outputs and the
agent's internal reasoning are left out, which is what makes megabytes of raw log readable in
under 5 000 lines. Section 2 below is the index into it: each failure is told there, and can be
found in the transcript at the point where the human caught it. The conversation is in Spanish, as it
happened.

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
scaling argument (D-2), six phases (D-35), dev tokens, sqlfluff only (later none, D-23), gitleaks (D-32).

### 2.14 A documented guarantee that was not true

The README and D-24 stated that "Prettier is the single formatter for SQL". It never was:
`.prettierignore` excluded `*.sql` and no SQL plugin was installed, so the SQL override in
`.prettierrc.json` was dead configuration. Caught while reviewing whether `scripts/` was needed at
all. sqlfluff then owned SQL layout explicitly, until it was removed altogether in phase 4 once
drizzle-kit generated the SQL (D-23).

### 2.15 Whose time zone is the deadline in?

The first design anchored deadlines to the tenant's time zone. The human asked what happens with
payments made all over the world. The answer reframed the question: the cardholder's and merchant's
locations are irrelevant; the obligation is between the issuer and the scheme, so the scheme's
calendar anchors it. D-6 revised to a per-window zone, `UTC` by default. The AI also stated plainly
that it had **not verified** each scheme's rulebook, so UTC is recorded as an assumption to confirm,
not as a fact.

### 2.16 "Safe against live data" that was not, until it was tested against live-like data

**What was asked:** the human asked directly whether running these migrations against the current
database could break it, suspecting some would.

**What the first version did:** every migration passed on an empty database and in CI, and the docs
called the runner live-safe. Four failures were then reproduced on throwaway databases:

1. **`lock_timeout = 5s` killed `CREATE INDEX CONCURRENTLY`** while any transaction older than 5 s was
   open, which is normal on a live database. The build was cancelled halfway, left an `INVALID`
   index, and every retry failed with "relation already exists". A setting added for safety made
   the safest operation fail.
2. **The invalid-index check was global.** Any unrelated invalid index in the database failed our
   migration *after* the index had been built successfully but before it was recorded, so the next
   run failed again with "already exists".
3. **The ledger was called `schema_migrations`**, the name several other tools use. A database
   carrying golang-migrate's table made the runner crash on its first query.
4. **A database with existing tables was half-migrated.** On a database with its own `cases` table,
   migrations 0001–0004 were applied and committed before 0005 failed.

**Correction:** D-33 revised. Concurrent builds run without lock or statement timeouts (their lock
does not block traffic); the runner drops only the invalid index *its* migration left; the ledger is
`triple_migrations`; and the runner refuses, before writing anything, a database with tables but no
ledger. Each failure has a regression test in `test/migrator.integration.test.ts`, including one that
holds a transaction open for 6 s and asserts the build waits instead of failing.

**What it still does not do:** adopt an existing schema. These migrations build the schema from
scratch (D-34); a live database with a legacy `cases` table would need a dedicated baseline
migration, and the runner now says so instead of failing in the middle.

### 2.17 Tests that passed without proving their claim

Two domain tests were green on the first run and still wrong, caught on re-reading them rather
than by any tool:

- **"orders money, not minor units"** compared a KWD and a JPY amount whose raw minor units and
  converted values sorted the *same* way, so it would have passed with the bug it claimed to rule
  out. It now uses ¥30 000 against €200.00, where raw minor units and money disagree.
- **"history never re-evaluates rules"** asserted the arity of `foldHistory`. A structural check,
  not behaviour. It now folds a stored `WON` that today's rules would turn into `LOST`, and asserts
  history still says `WON`.

The coverage gate found a third issue in production code rather than tests: wall-clock parsing in
`src/domain/deadline` fell back to `0` for a missing date part, which would have produced a wrong deadline
silently. It now throws. The domain's statements threshold is 99%, not 100%, because that throw
cannot be reached without mocking `Intl`.

### 2.18 A domain that worked and could not be maintained

**What came back:** phase 2 as six flat files. Each mixed constants, types, Zod schemas, error
classes and functions; `case.ts` alone held six decisions, their input and output types, the
history fold and private helpers in 272 lines. Tests were green and coverage was 100%.

**How it was caught:** the human read it and said it was unmaintainable: there was no way to know
where anything lived without opening every file. Nothing automated would have flagged it, because
nothing was wrong except the shape.

**Correction:** D-36. Blocks per business concept, fixed file roles, an `index.ts` per block as its
public API, a one-way dependency direction, and all of it enforced by ESLint rather than left as a
convention. The move changed no behaviour: the same 107 assertions pass, only imports changed.

### 2.19 A history that summarised instead of telling

**What happened:** phases 0 to 2 were committed one commit per phase, or per large follow-up:
`chore: phase 0 foundation` (+7 699 lines), `feat(domain): phase 2 domain core` (+1 605),
`refactor(domain): organise the domain in blocks…` (57 files). Every commit followed Conventional
Commits and passed commitlint, and every message was accurate.

**How it was caught:** the human pointed out that the titles could only summarise and the bodies had
become lists, so the history did not show what had been built or in what order. Commitlint checks
the format of a message, not whether a commit is one change. A reviewer could not read the phases
step by step, bisect a regression, or revert one concern without the others.

**Correction:** D-37. From phase 3 on, commits are atomic: one logical change, green on its own, with
tests and docs alongside the code they belong to. Work is presented as a commit plan the human
approves once, and each commit is verified individually with `git rebase --exec`. The existing
history is left intact, as the brief asks, rather than rewritten to look better than it was.

### 2.20 The ORM that phase 0 threw away

**What happened:** in phase 0 the AI removed `drizzle-kit` because `npm audit` reported four moderate
advisories (2.3), argued that hand-written SQL was more auditable, and left `drizzle-orm` installed
and unused. Phases 1 and 2 then built a schema with no types, no validation derived from it, and
nothing to stop the SQL and the code drifting apart.

**How it was caught:** the human said plainly that this had been a mistake: the stack had been
chosen to be used, and the project was reinventing what the libraries already do. A new rule went
into AGENTS.md ("Libraries before custom code"): check the library first, in its documentation
*and* its installed source, and build only the gap that is verified to exist.

**What the surgical analysis found:**

- The advisories are all one issue in esbuild's *development server*, which drizzle-kit never runs,
  in a devDependency. `npm audit --omit=dev` is clean. The phase-0 reason was overstated.
- drizzle's migrator, read in `drizzle-orm/pg-core/dialect.js`, really is unfit to *apply*
  migrations to a live database: one transaction for every pending migration (no
  `CREATE INDEX CONCURRENTLY`), pending-ness decided only by the last applied timestamp (edited and
  out-of-order files pass silently), no lock. These are the same failures the runner was hardened
  against in 2.16.

**Correction:** D-38. Drizzle defines the schema and the queries, drizzle-zod the request schemas,
drizzle-kit generates and checks migrations, and only applying them stays custom. The hand-written
`0001`–`0010` were kept as the baseline rather than rewritten; a drift test builds one database from
the migrations and another from the TypeScript schema and compares the catalogues. It caught a
real mismatch on its first run: Drizzle names primary and foreign keys differently from PostgreSQL,
which would have made drizzle-kit try to rename constraints in the next migration.

### 2.21 Documentation, types and source disagreed; the source won

Three times in phase 3 the documented behaviour of a library was not what the installed version did:

- Hono's documentation shows `verify(token, secret, alg, issuer, aud)`; the installed version takes
  `verify(token, key, { alg, iss, aud })`. It also only checks `exp` *if the token has one*, so a
  token without `exp` would never expire; the API now requires the claim.
- `drizzle-kit/api` declares its snapshot type with zod 3; with zod 4 installed the type does not
  resolve. `tsc` hid it behind `skipLibCheck`; typed ESLint did not.
- `pushSchema` from the same API hung without an error, so the drift test uses the in-memory
  generator instead.

Each was settled by reading the installed `.d.ts` or running the code, not by trusting the page.

### 2.22 An API test found a domain inconsistency

Phase 2's domain answered `OPEN` on an already-`OPEN` case with a no-op, because it checked "same
status" before "OPEN is not an action". The documented contract says `OPEN` is always a `422`.
Domain tests passed, because they only tried `OPEN` on cases in other states; the first API test
that tried it on a fresh case failed. The order was fixed in the domain, where the rule lives, and
the missing case was added to the domain tests.

### 2.23 Business logic the AI invented, caught by the human

**What happened:** the brief asks for *"configurable, ordered rules"*. In phase 1 the AI added an
`enabled` column to `tenant_rule_config`, so a tenant could switch a rule off, and in phase 2 the
domain honoured it, with tests ("lets a tenant disable the automatic loss"). Nobody asked for it;
it looked like a natural extension of "configurable".

**How it surfaced:** planning the phase 4 sweeper, the AI found that a tenant with `deadline_passed`
disabled would leave expired cases `OPEN` forever, be re-selected on every sweep, and could starve
the sweeper for every other tenant. Its first proposal was to *protect* the switch: a database
constraint and a domain check forbidding that one rule from being disabled, plus a plausible
business reason a bank might want it.

**How it was caught:** the human asked why a bank should be able to do this at all, and told the AI
not to exceed the brief or presume. Looked at plainly, the switch had no valid use for any rule:
switching off `deadline_passed` makes the system contradict the card network, which loses the case
anyway; switching off `evidence_filed` makes evidence impossible to file; switching off
`scheme_outcome` makes `WON` unreachable. The business reason offered was the AI's own invention.

**Correction:** remove what was invented instead of adding code around it. Tenant configuration is
the rule **order** only, which is what the brief asks for. Done in two steps, as a live database
would need: the code stops reading the column, then a drizzle-kit migration drops it. The sweeper
problem disappears with it. Lesson recorded in AGENTS.md's spirit: a feature with no use case is
not "flexibility", it is a liability someone later has to defend.

### 2.24 An index designed before its query, and the data to check it planned too late

**What happened:** phase 1 created the stuck-queue indexes before the report query existed. They
matched the filter, `(tenant_id, deadline_at)`, but not what the query does next: order by
`(amount_base_minor, id)` and page by a cursor on both. Without `id` in the index PostgreSQL ignored
it and read one table block per case at risk. Separately, the plan put the performance fixture in
phase 5 while phase 4's exit criterion was an `EXPLAIN`: the evidence was scheduled after the
decision it was needed for.

**How it was caught:** planning phase 4, the AI wrote the query and saw the gap; the human called it
a planning error and asked why the seed they expected did not exist.

**Correction:** the 1M-case seed moved to the start of phase 4. Two candidate indexes were measured on
it: the covering `(tenant_id, deadline_at) INCLUDE (amount_base_minor, status, id)` took the first
page from 32 ms to 1–3.5 ms; one ordered by amount took 23 ms, because most deadline losses are old
and walking by amount discards thousands of them. The winner was added with `CONCURRENTLY` as an
expand step (no row touched, no write blocked); the old indexes are dropped in phase 5, after
measuring that the summary moves to the new ones. `npm run perf:explain` re-runs the SQL Drizzle
actually generates under `EXPLAIN`, so the evidence is the real query, not a hand-written copy.
The method recorded: write the query, then design the index, then prove it on representative data.

### 2.25 Green tests, red CI: a teardown race

All 172 tests passed in CI and the job still failed on an uncaught `57P01 terminating connection
due to administrator command`. Reading pg-pool's source: `end()` resolves as soon as its clients are
detached, before their sockets close, and the test helper then ran `DROP DATABASE … WITH (FORCE)`,
which killed those closing sessions; the FATAL reached a client with no listener. It never showed
locally, only on CI timing. The helper now waits until `pg_stat_activity` reports no session on the
database before dropping it.

### 2.26 Smaller misstatements caught on re-reading

- The performance seed's header promised "one case with 400 events" that the code did not create.
  Added, so the comment and `perf:explain` are true.
- A report test was commented "each test gets its own API" while the API was shared, and it only
  passed because it ran first. A first fix compared the summary with itself, which proves nothing.
  It now records the summary before creating its cases and asserts the exact increase.

### 2.27 The performance data was invisible where the human looked

**What happened:** the first version of `seed:perf` built a separate database, `triple_perf`, with the
`cases` projection only. The human seeded it, opened their development database, found nothing,
and could not run the `EXPLAIN`. Even where the data was, it could not be explored through the API
(no dev tenant), and a case's history was empty, which is the opposite of an audit trail.

**Correction:** the seed now writes into the development database, mostly under the Acme dev tenant,
and generates for every case the events that explain its status, so the projection equals its log
(checked: 0 mismatches) and the report and any history can be read with `npm run dev:token`. A side
effect settled an open phase 5 item: with 2.8M events in `case_events`, the 400-event history is an
index scan on `case_events_pkey` (0.06 ms) instead of a sequential scan of a near-empty table that
proved nothing.

### 2.28 The end-of-phase review found three defects the tests did not

Before committing phase 4, the human asked for a review of everything the phase created. Read as a
whole, three things were wrong although all 198 tests passed:

- **The sweeper could never run in production.** It loaded the API's whole configuration, so it
  demanded the JWT secret it never uses, and it inherited the rule that refuses dev auth when
  `NODE_ENV=production`. As a Lambda or a CronJob it would have failed at start-up. Configuration
  is now split (D-46): `runtimeEnv()` for every process, `apiEnv()` adds the API's own settings.
  Verified by running the sweeper with `NODE_ENV=production` and no JWT variable at all.
- **A report could contradict itself.** Its summary and its page were two queries, each seeing its
  own committed state; a sweeper batch committing between them would move a case from `at_risk` to
  `breached` in one half only. Same for a history (the case, then its events). Multi-query reads
  now run in one read-only `REPEATABLE READ` snapshot (D-47), with a test proving the option reaches
  PostgreSQL.
- **A migration cited a document that did not exist** (`docs/PERFORMANCE.md`). The migration is
  applied, so its text cannot change; the document was written instead, with the measurements.

### 2.29 The AI advised against the 10M run; the human asked for it anyway

**What happened:** the brief's scenario 4 names a tenant of about ten million rows. Phase 4 measured
on one million and argued the rest (a B-tree gains at most one level; the report depends on the
size of the queue, not of the table). Planning phase 5, the AI recommended not running 10M at all
and leaving the argument as the evidence. The human decided to measure.

**What the run showed:** the argument held (first page 1.1 ms → 5–6 ms with a queue ten times
larger, history 0.06 ms among 27.9M events as among 2.8M, the whole report request in 17–24 ms), so
the recommendation would not have produced a wrong system. But it would have left the brief's own
number unmeasured, and three things only the run could show: PostgreSQL switches the report to
parallel plans at that size; the default page discards 50 781 of the 81 507 index entries it reads,
because the queue index is shared with the summary; and timings on a new connection are about
twice those on a warm one, which a single `EXPLAIN` hides. All three are in
`docs/PERFORMANCE.md`. An argument is a prediction; the run is what turns it into evidence, and it
cost 21 minutes.

**A wording failure in the same step:** reporting the contract measurement, the AI wrote that the
old indexes were "only used by the summary", and the human read it, reasonably, as "the summary
needs them", which makes dropping them look like a regression. The fact was the opposite: the new
indexes hold the same columns plus `id`, and the planner picked the old ones only because they are
slightly smaller. The human asked for the reason in plain words before approving, and wanted the
decision to rest on performance; the measurement (same time with and without, inside a rolled-back
transaction) was what settled it, not the AI's recommendation. The write-side gain of dropping them
was reasoned, not measured, and the documents say so.

**A human decision recorded as an objection, not built:** on the growth of `case_events` the human
set the direction (hot data in PostgreSQL, old data to Parquet on S3 queried with Athena, a warm
tier to be thought through) and was explicit that nothing is to be done now (D-49). The AI's part
was to write down what that policy collides with in this design: events cannot be deleted by
anyone today, a case's history needs all its events, and bulk deletes are what would reopen
partitioning.

### 2.30 The AI designed the alerts for a tool the company does not use

**What happened:** asked to explain the SLO work before doing it, the AI proposed a new gauge on
the Prometheus `/metrics` endpoint and alert rules written in PromQL. It never asked what the team
monitors with; it assumed Prometheus because phase 0 had added a `/metrics` endpoint, which was
itself an unasked default. The human answered that the company uses Sentry.

**What changed:** the plan, entirely. With Sentry the sweeper needs no database gauge and no
endpoint to be scraped, which a one-pass scheduled job could not offer anyway: it checks in with a
cron monitor on every pass and pushes its lag as a metric. Errors and latency come from Sentry's
Hono integration. The design got smaller, not larger (D-50). The same class of error as 2.23:
filling a gap in the brief with an assumption instead of a question.

**What the library did by default, found in its source:** Sentry's Hono integration reports every
error that does not carry a 3xx/4xx `status`. `CaseError` carries none, so with the documented
setup every late-evidence `409` and every unknown-case `404` would have been an error event, and
the "failed write" alert would have paged on exactly what `docs/SLOS.md` says must not page. It was
found by reading `defaultShouldHandleError` in the installed package before wiring it, then proved:
the test that checks a rejection is not reported fails with Sentry's default and passes with the
project's filter.

**Verified without a Sentry account:** a local HTTP server stood in for Sentry and recorded what
the API and the sweeper sent: both check-ins with the monitor's configuration, the lag metric, one
trace per request named by route, and no error event for a `404`. What was *not* verified is the
Sentry side (creating the monitors, routing a page), and the document says so.

**Coupled to the provider, caught by the human:** the first implementation called Sentry from
four places (the API's entry point, an HTTP middleware file, the sweeper, a shared options file),
with files named after it. The human asked for the provider to be abstracted so that changing it
is possible, in the code and in the commit titles. Everything that names Sentry now lives in
`src/monitoring`, behind functions named for what they do (`trackErrors`, `watchSchedule`,
`recordGauge`), and an ESLint rule rejects the import anywhere else. The same review removed the
Prometheus endpoint (D-51) and the "3am" of the brief from titles: the subject is which alerts
need the person on call.

**A side effect to record:** verifying the sweeper meant running `npm run sweep` against the
development database, and it did its job: 5 461 seeded cases whose deadline had passed overnight
were recorded as `DEADLINE_EXPIRED`. Correct behaviour, and append-only, but a write to the human's
database that was not announced beforehand. The invariant check afterwards: 10 000 001 cases, 0
mismatches.

### 2.31 The last review: a version in the path, asked for and then withdrawn

**What happened:** the human followed the README from start to finish as a final check; every
command worked. Reading the URLs, they asked for the major version to be added to every path
(`/v1/...`), which is what a new API should have.

**What the AI did:** before changing anything it said that the request contradicted a recorded
decision (D-27) and one sentence of the brief, "banks consume `GET /cases/:id`, so keep it
working", the same sentence the AI itself had broken in 2.12 with `/v1/cases/:external_ref`. It
proposed serving `/v1/...` as the documented base and keeping the unversioned paths as an alias.

**Decision:** the human withdrew the change: the paths stay unversioned, and the reasoning is
written down instead (TRADEOFFS §14b): versioning would be better, and it is not added for
continuity of service. This is the rule in `AGENTS.md` working as intended: a change that
contradicts a decision is said out loud, and the register is updated either way.

**The opposite case, in the same review:** the AI had recommended removing `/metrics` for lack of
a consumer, and the human agreed. Afterwards the human pointed out what it had been good for
here: in an exercise no provider is connected, so an endpoint is the only way to see the numbers.
The removal stands; the gap is recorded (`docs/SLOS.md`). The AI's recommendation was right about
the team's tooling and missed the reviewer's situation.

### 2.33 Red CI again: a race the AI had handled for only one of its two errors

**What happened:** after the phase 5 push the pipeline failed in one test file with `duplicate key
value violates unique constraint "pg_authid_rolname_index"`. The human pasted the log.

**Cause:** every API test file runs in its own database, in parallel, but roles belong to the
whole server. Each file checks whether `triple_api` exists and creates it if not, so several can
try at once. The helper written in phase 3 expected that and ignored the error "role already
exists". PostgreSQL has a second answer for the same situation: when two sessions insert the role
at the same instant, the loser gets a unique violation on the catalogue instead, with a different
message. The helper matched on the message text, so that one escaped. It never showed locally
because `npm run dev:seed` had already created the role there; in CI the server is new every run.

**Proof, not a guess:** a throwaway PostgreSQL with the role dropped before each run. Before the
fix the suite failed 2 runs out of 6; after it, 0 out of 16. The helper now recognises both by
their SQLSTATE codes (`42710`, `23505`), not by wording.

**The lesson is 2.25 again:** a test suite that only ever ran against a prepared database was not
tested against the empty one CI uses.

---

## 3. Decision register

Each decision states the choice, the reason, and what was rejected. **(rev.)** marks a decision
revised during the design review recorded in 2.10 to 2.15; the earlier version is described in the
rejected column.

| ID | Decision | Why | Rejected alternative |
| --- | --- | --- | --- |
| **D-1** | Single tenant as an explicit **working hypothesis**. `tenant_id` on every business table; tenant taken only from the verified token. | Costs nothing, keeps the 60+ tenant target shape, enabled by seeding rows. | Tenant administration machinery for a hypothesis the brief does not state. |
| **D-2** (rev. 3) | **1M cases with their full event history** (2.8M events, invariant 3 holds), generated in SQL **into the development database**, mostly under the Acme dev tenant (`npm run seed:perf`, ~1 min, once; `--rows` for more or fewer), at the **start of phase 4**. `npm run perf:explain` runs the real Drizzle SQL under `EXPLAIN (ANALYZE, BUFFERS)`. | Indexes must be chosen on representative data (2.24); in the dev database the volume is explorable through the API with the same token, and a realistic event log makes the history plan meaningful (2.27). | A separate `triple_perf` database with no events (the first phase-4 version); the fixture in phase 5; 10M as the default on a laptop. |
| **D-3** (rev.) | `response_windows(scheme, reason_code NULL, window_days, deadline_tz)`, `UNIQUE NULLS NOT DISTINCT (scheme, reason_code)`, changed by migration. The window is **snapshotted onto the case**. | Satisfies `window(scheme, reason_code)` and "windows are data". The snapshot means a reissued window never moves a live deadline. | Effective-dated rows with `EXCLUDE` over date ranges and `btree_gist`: served only late registration across a rule change. `DEADLINE_REVISED` batches are reserved, not built. |
| **D-4** (rev.) | `amount_minor BIGINT` + `currency CHAR(3)` in the database, ISO 4217 exponent map in code. **The API still accepts and returns `amount_cents`**, plus `amount_minor` and `currency_exponent`. | `amount_cents` is wrong for JPY and KWD, but it is the brief's field and banks consume it. Fixing the model must not break the contract. | Renaming the API field (breaking, 2.12); `double precision`; `NUMERIC`; a fixed two-decimal convention. |
| **D-5** (rev.) | Static `fx_rates(currency, base_currency, rate, rate_date)`; `amount_base_minor`, `fx_rate`, `fx_rate_date` snapshotted at creation. | The report must order by money across currencies, reproducibly. | Live FX at report time. Production would source rates from scheme settlement or the bank's provisioning rates (TRADEOFFS §15). |
| **D-6** (rev.) | `deadline_at` = end of day `presentment_date + window_days` in the **window's** zone (`deadline_tz`, default `UTC`). Half-open `instant < deadline_at`. | The obligation is issuer ↔ scheme, so the scheme's calendar anchors it; UTC removes DST; half-open gives a boundary one answer. UTC is an unverified assumption per scheme. | The tenant's time zone (2.15); `timestamptz + interval`; a closed interval. |
| **D-7** | `actor_type IN ('human','agent','system')`, `actor_id` always set; from the token (user → `human`, machine client → `agent`); `system` only for `DEADLINE_EXPIRED`, enforced by a `CHECK`. | An automatic loss needs an honest actor; the API must not let a client claim to be the system. | The brief's two-value enum. |
| **D-8** (rev.) | Rule **predicates in TypeScript**; `tenant_rule_config` holds the **order** (`priority`) only, which is what the brief asks for. No admin API; changes by migration. | Evaluated text in a table is an attack surface and untestable; the order is plain data. With corrected predicates, order only decides rule 1 vs rule 3. | Predicates as SQL or a DSL; everything hardcoded; a per-rule on/off switch, which the AI invented and the human removed (2.23). |
| **D-9** (rev.) | Periodic sweeper over **`OPEN` only**, `FOR UPDATE SKIP LOCKED`, batch, idempotent, `system` actor. | `UNDER_REVIEW` filed evidence in time and cannot lose to the deadline (2.10). | Sweeping `UNDER_REVIEW` too; lazy evaluation on read; `pg_cron`. |
| **D-10** (rev.) | `case_events` append-only by **grants** (`triple_app`: `SELECT`, `INSERT`), a **trigger** rejecting `UPDATE`/`DELETE`/`TRUNCATE` for every role, and **`ON DELETE RESTRICT`** to `cases`. `metadata JSONB` validated per type, ≤ 16 KB, no personal data. A future "delete" is a `CASE_VOIDED` event. | Audit that a single SQL statement can erase is not audit. | `ON DELETE CASCADE` (deleting a case erased its trail); convention only. |
| **D-11** (rev.) | **Rules run on write only.** Events store `to_status`, `rule_key`, `ruleset_version`. History folds events with `recorded_at <= as_of` by `seq`, never evaluating a rule. 50 000-event cap with `truncated`. | The past must not depend on today's code or config (2.11). | Re-evaluating rules on read with `clock = as_of`; with `now()` (2.8). |
| **D-12** (rev.) | v1 auth: locally minted HS256 tokens, refused in production; tenant and actor from claims only. Implemented in D-39. | Tests tenant isolation without IdP setup. | OIDC/JWKS in v1 (deferred, TRADEOFFS §15); identity from headers. |
| **D-13** (confirmed) | **No partitioning.** Confirmed in phase 5 on 10M cases and 27.9M events. | No measured query depends on a table's size: history uses the primary key (0.06 ms at both sizes), the report and the sweeper use partial indexes holding only the work queue (34 MB, 98 MB, 2 MB). Reopened only by bulk deletion of old events (D-49). | Partitioning up front. |
| **D-14** | The migration runner supports **per-migration transaction control** (`-- migrate:no-transaction`, one statement per file). | `CREATE INDEX CONCURRENTLY` cannot run in a transaction and must stay in the migration system. | Wrapping every migration in a transaction. |
| **D-15** | `typescript@5.9.3`, pinned exactly. | `typescript-eslint@8.71.0` requires `<6.1.0`. | `typescript@latest` (7.0.2). |
| **D-16** | ESLint 10 flat config, `strictTypeChecked`, layer boundaries via `no-restricted-imports`, `perfectionist` ordering. | Type-aware rules catch defects; the domain cannot import infrastructure. | ESLint without types; layering by convention. |
| **D-17** (rev.) | `console` banned by ESLint (`no-console`, `no-restricted-globals`) with **`linterOptions.noInlineConfig: true`**, so no source file can switch a rule off. | Same guarantee as the old grep guard, enforced in one place. | A separate grep script duplicating ESLint. |
| **D-18** | `pino` with redacted credentials, `pino-pretty` only in development. | Structured, safe logs. | `console.log`. |
| **D-19** (rev.) | `pre-commit`: lint-staged (ESLint and Prettier on staged files). `pre-push` and CI: typecheck, lint, tests, build. Both `set -e`. | Fast commits, strict gates where they cannot be skipped. | `tsc` on every commit. |
| **D-20** | Conventional commits via commitlint. | The history is a deliverable. | Unvalidated messages. |
| **D-21** | `postgres:17-alpine`, port 5433, healthcheck, data checksums, CI service container. | Current version; no clash with a local PostgreSQL; integration tests really run in CI. | A cached 16-alpine image. |
| **D-22** | `SWEEP_INTERVAL_MS`, default 60 000, configurable. | Sweep lag is an SLO. | A hardcoded interval. |
| **D-23** (rev. 2) | **No SQL linter.** sqlfluff was removed once drizzle-kit started generating the SQL: table changes are generated and verified by `db:schema:check` and the drift test, the few custom migrations are reviewed by eye, and the linter had already needed two rule exclusions (`RF04` for our column names, `RF06` because drizzle-kit quotes identifiers) to stop fighting the code. Every real migration defect so far was caught by tests, none by the linter. | No tool without a use case (AGENTS.md); the human saw no need for it once Drizzle was adopted. | Keeping sqlfluff in CI (first a pure-Node checker as well, phase 0). |
| **D-24** (rev.) | Prettier does not touch SQL. | It never did (2.14); saying so is the fix. | Claiming Prettier formats SQL. |
| **D-25** | `POST /cases/:id/transitions { to }` maps `to` to a domain fact; the rules decide; a mismatch is `409` naming the rule; same status is a no-op `200`. | Keeps the brief's vocabulary while `UNDER_REVIEW` keeps its meaning: evidence filed in time. | Clients setting any allowed status. |
| **D-26** | `seq` = new `cases.version`, taken in the projection `UPDATE`; primary key `(case_id, seq)`. | Concurrency-safe via the row lock, gapless (a gap reveals tampering), and it is the history index. | `MAX(seq)+1`, a global identity, timestamps. |
| **D-27** (confirmed) | Unversioned paths (`/cases/:id`), additive-only responses, lookup by `?external_ref=`. A major version in the path would be the better design for a new API; it is not added, for continuity of service (2.31, TRADEOFFS §14b). | "Banks consume `GET /cases/:id`, so keep it working" (2.12). Moving the paths under `/v1` is the breaking change versioning exists to prevent. | `/v1/cases/:external_ref`; moving every path under `/v1` at the end of the exercise. |
| **D-28** | Rules evaluated **at creation** too; the report returns `at_risk`, `responded` and recently `breached` rows with `deadline_state`. | Scenario 2 becomes deterministic, and lost money stays visible. | Waiting for the sweeper; hiding breaches from the report. |
| **D-29** | Creation idempotent on `UNIQUE (tenant_id, external_ref)`: same payload → `200` with the case, different → `409`. | The natural key already prevents duplicates; no key table needed. | An `Idempotency-Key` store. |
| **D-30** | Event catalogue v1: `CASE_CREATED`, `EVIDENCE_FILED`, `SCHEME_OUTCOME_RECORDED`, `DEADLINE_EXPIRED`, `NOTE_ADDED`. `NOTE_ADDED` exists so the trail shows the work, not just the status, and makes a 400-event case realistic. | A closed set, enforced by `CHECK` and by the type union. | Free-form event types. |
| **D-31** | `recorded_at` = database `now()`, forced by trigger; clients cannot send `occurred_at`; only `DEADLINE_EXPIRED` carries `occurred_at = deadline_at`. | One clock; no backdating. | Application timestamps; client-supplied event times. |
| **D-32** | Secret scanning with **gitleaks v8.30.1 in Docker** over the full history, in CI and as `npm run scan:secrets`. | A maintained scanner instead of 130 lines of local regexes. | The homemade guard script. |
| **D-33** (rev.) | Runner: SHA-256 checksums, advisory lock, ledger named `triple_migrations`, refusal of a non-empty database without a ledger, `lock_timeout = 5s` for transactional migrations, **no timeouts for concurrent index builds** and cleanup of the `INVALID` index a failed build leaves, forward only. | Safe and auditable against live traffic (2.16). | A uniform `lock_timeout` and a global invalid-index check (2.16); `drizzle-kit` (2.3); a `down` command nobody tests. |
| **D-34** | Greenfield schema with **live-safe migrations**, plus a written rollout plan for 60+ tenants (`docs/MIGRATION_PLAN.md`). No invented legacy import. | What the brief asks is that our migrations can run on live data. | Modelling and backfilling a hypothetical legacy database (2.13). |
| **D-51** | **The Prometheus `/metrics` endpoint and its client library are removed.** | Nothing read it: it waits to be scraped and the team has no Prometheus. It was added in phase 0 by the AI as a default nobody asked for, and cost a dependency, a middleware on every request and an unauthenticated endpoint. What it measured (request duration by route and status) is covered by the monitoring in D-50. | Keeping it in case a scraper appears: a decision to take with the company's infrastructure, not to pre-build. |
| **D-50** | **SLOs watched with Sentry** (`docs/SLOS.md`). Pages: failed writes (requests answered with a 500) and a sweeper that stops or falls behind. Not pages: a breached deadline, late evidence (business outcomes, shown by the report), latency (ticket). Everything goes through `src/monitoring`, the only folder that names the provider (ESLint-enforced): the API reports only what it answers with a 500, plus a trace per request; every sweeper pass is watched on a schedule defined in code and pushes its lag. Off unless `SENTRY_DSN` is set. | The team uses Sentry (2.30). A page is for what an engineer can fix and what worsens by waiting. A scheduled one-pass sweeper cannot be scraped, so it must push. | A Prometheus gauge and PromQL rules (no consumer in the team); calling the provider from each process (changing it would touch them all); Sentry's default error filter (reports every business rejection); paging on breached deadlines. |
| **D-49** | **Retention of `case_events` is left open on purpose; nothing is built.** Recorded as an objection to the current design: the log is append-only and grows about 0.73 GB per million cases. Direction set by the human for when it is decided: recent events stay in PostgreSQL (hot), old ones move to cold storage (Parquet on S3, queried with Athena), a warm tier to be thought through. | It is a retention policy, which is a business and compliance decision, not a performance one: no query is slower because of the table's size (D-13). | Building an archiver now; deleting events by age (a case's status is the fold of all its events, so whole closed cases move, not single events; and D-10 forbids every delete today, so it needs its own authorised copy-verify-delete process). |
| **D-48** | **Contract step:** `cases_at_risk_idx` and `cases_breached_idx` dropped with `DROP INDEX CONCURRENTLY`, one migration each. Performance is measured at **10M cases** as well as 1M (`docs/PERFORMANCE.md`, with the raw `EXPLAIN`). | The queue indexes (D-45) hold the same columns plus `id`; measured on 10M inside a rolled-back transaction, the summary takes the same time without the old pair (6.4–7.2 ms against 6.3–10.3 ms). Two indexes fewer on every write to `cases`, 102 MB freed (2.29). | Keeping both pairs; dropping without measuring the summary first. |
| **D-47** | Reads made of several queries (the stuck-queue summary and page, a case and its events) run in one **read-only `REPEATABLE READ`** transaction (`transaction(work, { snapshot: true })` on the port). | One state of the database per answer: a report must not contradict itself (2.28). | Default `READ COMMITTED`, where each statement sees its own snapshot. |
| **D-46** | Configuration in two parts: `runtimeEnv()` (database, logging, sweep interval) for every process, `apiEnv()` adding port and authentication for the HTTP API only; the dev-auth production refusal belongs to the API. | The sweeper must run in production and must not hold a secret it never uses (2.28). | One configuration object for every process. |
| **D-45** | Report indexes `cases_queue_idx` and `cases_queue_breached_idx`: `(tenant_id, deadline_at)` covering `amount_base_minor`, `status`, `id`, partial on the queue's statuses; added `CONCURRENTLY` as an expand step, the phase 1 indexes dropped later. Status constants are SQL literals in the adapter so the planner can match the partial indexes. | Measured on 1M cases: page 32 ms → 1–3.5 ms, summary index-only (2.24). | An index ordered by amount (23 ms); editing the phase 1 migration. |
| **D-44** | The sweeper is one function, `sweepDeadlines`, with two entry points: `npm run worker` (loop, this exercise) and `npm run sweep` (one pass). Production runs the one-pass form from a scheduler (EventBridge + Lambda, Kubernetes CronJob) every minute. | One code path whatever the deployment; a scheduler gives retries, history and no idle process (TRADEOFFS §7b). | A sweeper inside the API process; `pg_cron`. |
| **D-43** | `GET /reports/stuck-queue`: `summary` of `at_risk`, `breached`, `responded` always; `items` of `at_risk,breached` by default, `?state=` for any combination; ordered by base-currency amount then id; opaque keyset cursor; `seconds_to_deadline` per item; frozen v1 contract. | The brief's filter has no lower bound, so answered cases would bury the actionable ones; nothing is hidden, the brief's set is one parameter away (TRADEOFFS §7c). | The brief's literal filter as the default list; dropping responded cases; offset pagination. |
| **D-42** | The API connects as `triple_api`, a login role in `triple_app`, created by `npm run dev:seed` from `DATABASE_URL`; migrations and the seed use the owner's `MIGRATION_DATABASE_URL`. API tests run as `triple_api` too. | In the running system, not just in a test, the API cannot update or delete the audit trail or immutable case columns. | Connecting as the owner and relying on the trigger alone. |
| **D-41** | A frozen v1 case contract in `test/contract/case-v1.ts`, written by hand, non-strict, applied to every case response in the API tests. The history response is frozen the same way in `history-v1.ts` (phase 5). | Proves compatibility instead of promising it: adding a field passes, removing, renaming or retyping one fails. Derived from the code, it would change along with the bug. | The original exit criterion ("adding a field keeps assertions green"), which proved nothing. |
| **D-40** | One error envelope `{ error: { code, message, details? } }` for every failure, including Zod validation (route default hook), unknown routes and readiness; stable `code` list in `src/http/errors.ts`. | Integrators branch on `code`; one shape means one error handler on their side. | `@hono/zod-openapi`'s default validation response and ad hoc bodies per route. |
| **D-39** | Auth with `hono/jwt` (no new dependency): HS256, `iss`, `aud`, and `exp`, `sub`, `tenant_id`, `actor_type` required; `system` refused. Tokens come from `npm run dev:token`; the API has no issuing endpoint. The server refuses to start with `NODE_ENV=production` until a real mode exists. | The current use case is local development and tests; OIDC later is `verifyWithJwks` from the same library. | `jose`; an HTTP endpoint that mints tokens; trusting hono/jwt's optional `exp` check (2.21). |
| **D-38** | **Drizzle**: schema in `src/infrastructure/db/schema` (constraints named as PostgreSQL names them), typed queries in the `CaseStore` adapter, drizzle-zod for request schemas, drizzle-kit `generate`/`check` (timestamp prefix, custom migrations for triggers, grants, `CONCURRENTLY`, reference data). **Our runner applies.** `0001`–`0010` kept as baseline; drift test and `db:schema:check` in CI. | Libraries before custom code, with the one verified gap kept custom: drizzle's migrator uses one transaction, no checksums, last-timestamp detection and no lock (2.20). | Hand-written SQL and no ORM (phases 0–2); drizzle-kit `migrate`; rewriting `0001`–`0010`. |
| **D-37** | **Atomic commits from phase 3 on**: one logical change per commit, each green on its own, tests and docs with the code; imperative scoped titles that stand without the diff; bodies that give the reason and the `D-xx`/`NOTES` reference. Work is proposed as a commit plan approved once, and each commit is verified with `git rebase --exec`. Phases 0–2 stay as committed. | The history is a deliverable and must show how the system was built; small commits can be reviewed, bisected and reverted (2.19). | One commit per phase (what phases 0–2 did); rewriting the pushed history to hide it. |
| **D-36** | `src/domain` is organised in **blocks** (`shared`, `money`, `deadline`, `rules`, `events`, `dispute`) with fixed file roles (`types`, `constants`, `schemas`, `errors`, `<action>`, `index`). ESLint enforces: import a block only via its `index.ts`; dependencies only in the direction `shared ← money, deadline ← rules ← events ← dispute`; Zod only in `events`. The aggregate block is `dispute`, not `case`, to avoid the reserved word. | You know where a thing lives before opening a file, and the architecture cannot erode silently. Zod stays in the domain for event metadata because that shape is an audit guarantee and duplicating Zod by hand buys nothing (2.18). | Folders by kind (`types/`, `functions/`…), which scatters one concept across four places; flat files (the phase 2 shape); conventions without lint. |
| **D-35** | Scope: six phases (0–5); no console, no OIDC, no rules admin API, no voiding, no retroactive revisions. | The brief values a working result over breadth. | Seven phases with a console and full auth. |

---

## 4. What is deliberately unfinished at this stage

All six phases are complete. Recorded so the gaps are explicit rather than discovered by a
reviewer:

- **The Sentry side is not configured or tried.** The code sends the signals (checked against a
  local stand-in); the monitors in `docs/SLOS.md` have to be created in the team's Sentry, with
  the agreed thresholds (99.9%, 5 and 15 minutes).
- **The objectives cannot be read through the API.** Every signal is pushed to the provider, and
  in this exercise none is connected. `/metrics` did that and was removed for lack of a consumer
  (D-51); the human pointed out afterwards that this is exactly why it was useful here. Not needed
  now and not built; recorded in `docs/SLOS.md` as a known gap, with where it would go.
- **No scheduled audit of invariant 3** (a case equals its log). Run by hand only.
- **Retention of `case_events` is undecided** (D-49): the log only grows. The direction is written
  down (hot in PostgreSQL, cold in Parquet on S3); nothing is built.
- **No read from a cold disk was measured.** Timings are with the data in memory; the operating
  system's cache inside Docker could not be dropped. The write-side gain of dropping the two
  indexes was reasoned, not measured.
- **Seeded data is recorded at seeding time.** The trigger makes `recorded_at` the database clock, so
  a seeded case lost to its deadline shows `DEADLINE_EXPIRED` dated at the deadline but
  `CASE_CREATED` dated today. That is the system refusing to invent the past, as it would for any
  imported data.
- **`deadline_tz = 'UTC'` is an assumption** to confirm against each scheme's rulebook.
- **The FX table is a placeholder** for the exercise (TRADEOFFS §15).
- **Auth is development-only.** Tokens are minted locally with a shared secret; the server refuses
  to start in production until an OIDC mode exists.
- **`tenant_rule_config` has no rows and no API.** Every tenant uses the default rule order.
