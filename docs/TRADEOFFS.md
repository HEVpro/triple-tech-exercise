# Trade-offs

The brief ends with: *"We will spend our first 45 minutes debating the trade-offs behind these."* This
document is written to be that conversation, including the parts where the choice is uncomfortable.

Each entry states the decision, what was rejected, why, what it costs, and what would reverse it.
The full register is in [`../NOTES.md`](../NOTES.md) section 3; the model itself is in
[`DOMAIN.md`](./DOMAIN.md).

---

## 1. The four review scenarios

| # | Scenario | What it really tests | Our answer |
| --- | --- | --- | --- |
| 1 | Visa, presentment 40 days ago, `OPEN` → at-risk, deadline in 5d | Deadline arithmetic and the report filter | Deadline is the end of day 45 in the scheme's zone (UTC); the case is `at_risk` with ~5 days left |
| 2 | Mastercard, presentment 50 days ago, `OPEN` → breached | Time-driven loss without a human, deterministically | Rules are evaluated at creation, so the case is `LOST` immediately, and the report lists it as `breached` (§7) |
| 3 | 400 events, 2 years old, history < 200 ms | Whether the audit trail is the truth | Primary key `(case_id, seq)` is exactly the history index; the fold reads stored statuses, no rule evaluation (§3) |
| 4 | ~10M-row tenant, report < 100 ms, with `EXPLAIN` | Whether performance is measured or asserted | Partial covering index plus pagination; measured on 1M and on 10M cases: 17–24 ms end to end (§10) |

---

## 2. Audit trail: event log plus projection

**Decision.** `case_events` is the append-only source of truth; `cases` is a projection written in
the same transaction.

**Rejected.** A status column updated in place with a best-effort audit table.

**Why.** "What was this case on day X, and who changed it" cannot be answered once a column is
overwritten. Banks already consume `GET /cases/:id`, so the projection keeps that endpoint a single
indexed read while the log answers history.

**Cost.** Two representations that must agree; invariant 3 is the test that they do.

---

## 3. History: decide on write, never re-evaluate on read

**Decision.** Rules run only on write. Each event stores `to_status`, `rule_key` and
`ruleset_version`. History folds stored statuses; it never evaluates a rule.

**Rejected.** Replaying events through the rules with `clock = as_of` (the earlier design).

**Why.** Re-evaluating on read makes the past depend on today's code and today's
`tenant_rule_config`. Reordering a tenant's rules in 2027, or fixing a bug in a predicate, would
silently change what the system says about 2026. Storing the decision makes history deterministic,
explainable ("rule 2, ruleset v1") and trivially fast.

**Cost.** A wrong decision stays in the history and is corrected by a later event rather than
disappearing. For an audited system that is the desired behaviour.

**What would reverse it.** Nothing foreseeable; the alternative is strictly weaker for audit.

---

## 4. Clocks: the database clock, and no client timestamps

**Decision.** `recorded_at` is PostgreSQL `now()`, forced by a trigger. `occurred_at` equals it for
every client event; only `DEADLINE_EXPIRED` carries a different business time, the deadline.

**Rejected.** Application-server timestamps; client-supplied event times.

**Why.** Several app instances have several clocks; one database has one. A client-supplied time
would let evidence be backdated to dodge rule 1.

**Cost.** Evidence that was filed with the scheme on time but reported to us late is treated as late.
A future version can accept a scheme-verified submission time in `metadata`.

---

## 5. Deadlines: scheme calendar, UTC by default, snapshotted

**Decision.** End of day `presentment_date + window_days` in `response_windows.deadline_tz`, default
`UTC`. Half-open comparison. The window is snapshotted onto the case.

**Rejected.** The tenant's time zone (the earlier design); recomputing the deadline on read; a closed
interval.

**Why.** Disputes are worldwide, but the obligation is between the issuer and the scheme, so the
scheme's calendar anchors it. UTC also removes daylight-saving shifts. A snapshot means a reissued
window never moves the deadline of a case already in flight. A half-open interval gives a boundary
instant exactly one answer.

**Cost.** UTC is an assumption to confirm per scheme rulebook. If a scheme anchors to another zone,
that is one row changed by migration.

---

## 6. Response windows: the smallest table that satisfies the brief

**Decision.** `(scheme, reason_code NULL, window_days, deadline_tz)`, `UNIQUE NULLS NOT DISTINCT
(scheme, reason_code)`. Reason code row if present, else scheme default. Changed by migration.

**Rejected.** Effective-dated rows (`valid_from`/`valid_to`) with an `EXCLUDE` constraint over date
ranges, which needs `btree_gist`.

**Why.** The brief asks for `window(scheme, reason_code)` and for windows to be data. The extra
machinery only served one edge case: a case registered late, after a window change, whose
presentment predates it. The snapshot already protects every existing case.

**What would reverse it.** Late registration across a rule change becoming common. Add `valid_from`
then; the resolution query changes, the API does not.

---

## 7. Scenario 2: evaluate at creation, and show breaches in the report

**Decision.** A case whose deadline has already passed at creation is `LOST` in the same transaction.
The report returns the brief's at-risk rows plus recently breached ones, each with `deadline_state`.

**Rejected.** Leaving it `OPEN` until the sweeper runs, which makes the scenario's result depend on
timing; and showing only open work, which hides the money already lost.

**Cost.** The report goes beyond the brief's literal filter, and is two index scans joined with
`UNION ALL`. Listed as a deviation in §14.

---

## 7b. The sweeper: one function, a scheduler in production

**Decision.** `sweepDeadlines` processes `OPEN` cases past their deadline in batches of 500, one
transaction each, `FOR UPDATE SKIP LOCKED`. It has two entry points: `npm run sweep` (one pass) and
`npm run worker` (a loop every `SWEEP_INTERVAL_MS`, this exercise's default).

**Rejected.** Lazy evaluation on read (the stored status would lie to every other consumer,
including the report); `pg_cron` (domain logic in SQL); a sweeper inside the API process (its
health would depend on API load and restarts).

**How it should run in production.** As a scheduled one-shot rather than a resident process: an
EventBridge rule invoking a Lambda, or a Kubernetes CronJob, running the one-pass form every
minute. No idle process; retries and run history come from the platform; one minute matches the
lag SLO. A resident worker is better only if sub-minute lag were required or a pass could not
finish within the interval. Both call the same function, so the choice is deployment, not code
(D-44).

**Cost.** Up to one interval of lag between a deadline and its recorded loss. The report closes that
gap on its side: an `OPEN` case past its deadline is already shown as `breached`.

---

## 7c. The report: everything counted, the actionable listed first

**Decision.** `summary` counts `at_risk`, `breached` and `responded`; `items` list `at_risk` and
`breached` by default, ordered by money, and `?state=` selects any combination (D-43).

**Rejected.** The brief's filter as the default list: it has no lower bound, so `UNDER_REVIEW` cases
whose deadline passed months ago (they answered in time and wait for the card network) stay in it
forever and push the cases the bank can still save down the list. Also rejected: dropping them
(hides money pending) and an arbitrary lookback for them (no business reason for the cut).

**Cost.** The default view differs from the brief's literal set; the brief's set is
`?state=at_risk,responded`. Listed as a deviation in §14.

---

## 8. Transitions: the client asks, the rules decide

**Decision.** `POST /cases/:id/transitions { to }` keeps the brief's vocabulary, but `to` is mapped
to a fact (`EVIDENCE_FILED`, `SCHEME_OUTCOME_RECORDED`) and the rules decide the status. A mismatch
is a `409` naming the rule.

**Rejected.** A free state machine where the client sets any allowed status.

**Why.** `UNDER_REVIEW` has a business meaning (evidence was filed in time); letting a client set it
for other reasons would make rule 1 skip a case that never answered.

---

## 9. Sequence numbers: `cases.version`

**Decision.** `seq` is the new value of `cases.version`, taken in the same `UPDATE` that moves the
projection.

**Rejected.** `MAX(seq) + 1` (races without a lock); a global identity (gaps carry no meaning);
timestamps alone (ties).

**Why.** The update already locks the case row, so concurrency is free. Numbering is `1..n` with no
gaps, so a gap is evidence of tampering. `(case_id, seq)` is the primary key and the history index.
`version` doubles as an optimistic-concurrency token later.

---

## 10. Performance: what the numbers depend on

**Decision.** Partial covering indexes `(tenant_id, deadline_at) INCLUDE (amount_base_minor, status,
id) WHERE status IN ('OPEN','UNDER_REVIEW')` and the same for deadline losses, a page chosen from the
indexes alone and only its rows read from the table, keyset pagination. Measured on a **1M-case**
fixture (`npm run seed:perf`, `npm run perf:explain`):

| Query | Before (phase 1 index) | Now |
| --- | --- | --- |
| Report, first page | 32 ms, one table block per case at risk | 1.2 ms warm, 3.5–13.7 ms cold; index-only |
| Report, later page (cursor) | — | 0.9 ms |
| Report, summary | 2.2 ms | 1.3 ms; index-only |

The phase 1 index lacked `id`, which the order and the cursor need: it was designed before the query
it served (NOTES 2.24). An index ordered by amount was also measured and lost (23 ms): most
deadline losses are old, so walking by amount discards thousands of entries to find last week's.

**What the cost depends on.** A B-tree page holds a few hundred entries, so three levels index ~27M
rows: 1M and 10M both need three or four page reads to find where a tenant's range starts. After
that:

| Factor | Grows with total rows? |
| --- | --- |
| Descending the index | barely (logarithmic) |
| Reading rows inside the risk window | only those rows |
| Sorting them by amount | with the size of the at-risk set |
| Returning a page | constant (`LIMIT`) |
| Index and heap fitting in memory | **yes** — the real difference between 1M and 10M |

So the report's latency is governed by **the size of the at-risk set and whether the index is in
memory, not by the table's row count**. This was written before the 10M run and then checked
against it (phase 5): with a queue ten times larger the first page went from 1.1 ms to 5–6 ms, the
whole request takes 17–24 ms against the 100 ms target, and a 400-event history takes the same
0.06 ms among 27.9M events as among 2.8M. Plans, timings and the raw `EXPLAIN` are in
[`PERFORMANCE.md`](./PERFORMANCE.md).

**Cost.** Measured on a laptop with the data in memory; a read from a cold disk was not measured
(the operating system's cache inside Docker could not be dropped). The default page discards the
`UNDER_REVIEW` entries of the shared queue index (50 781 of 81 507 read at 10M); an `OPEN`-only
index would avoid it at the price of another index on every write, which 6 ms does not justify.

---

## 11. Multi-tenancy: shared tables, tenant from the token

**Decision.** `tenant_id` on every business table, one seeded tenant, tenant taken only from the
verified claim. Cross-tenant reads return `404`.

**Rejected.** Tenant from a header, body or query parameter; building tenant administration now.

**Cost.** Claiming a multi-tenant design while running one tenant requires a test that proves
isolation; phase 3 has it.

**What would reverse it.** Nothing; this is the cheap direction to be wrong in. Row-level security is
a reasonable later defence in depth.

---

## 12. Terminal rules: predicates in code, order as data

**Decision.** Predicates are TypeScript; `tenant_rule_config` holds the order (`priority`). No admin
API; changes by migration.

**Rejected.** Predicates as SQL or a DSL in a table; everything hardcoded.

**Why.** Evaluated text in a table is an injection and privilege-escalation surface and is hard to
test. The order is plain data. Switching rules off was considered and removed: no rule has a
valid reason to be off (NOTES 2.23).

**Honest cost.** With the corrected predicates, order matters only between rule 1 and rule 3, and
only in one situation: no evidence, the deadline passed, and the scheme's outcome arriving before
the sweeper has recorded the loss, a window of about a minute when the sweeper runs. The
configurability the brief asks for exists and is proven end to end (the development seed gives
Globex a different order and an integration test compares it with Acme), but its practical reach
is small. Reading the order costs one primary-key query on every write.

---

## 13. Storage and migrations

- **No partitioning** (D-13), confirmed on 10M cases: history goes through the primary key and the
  report and the sweeper through partial indexes holding only the work queue (34 MB, 98 MB, 2 MB
  over a 2 GB table), so no measured query depends on a table's size.
- **Retention of `case_events` is an open decision, not a design** (D-49). The log is append-only
  and grows about 0.73 GB per million cases. Nothing is done now; the objection is recorded so the
  decision is taken on purpose. The direction, when it is taken: keep recent events in PostgreSQL
  (hot), move old ones to cold storage (Parquet on S3, queried with Athena), and decide whether a
  warm tier in between is needed. Three constraints any such policy meets here: nobody can delete
  an event today (grants and a trigger, D-10), so archiving needs its own authorised process that
  copies, verifies, then deletes; a case's status is the fold of **all** its events, so what moves
  is whole closed cases, not events by age; and deleting rows in bulk from an unpartitioned table
  is slow and leaves bloat, which is what would reopen D-13, since dropping a partition is
  instant.
- **Per-migration transaction control** (D-14), so `CREATE INDEX CONCURRENTLY` lives inside the
  migration system. Cost: a concurrent build can fail halfway and leave an `INVALID` index; the runner
  drops the one it left so the retry is clean, and runs the build without timeouts so an open
  transaction makes it wait rather than fail.
- **Greenfield schema, live-safe migrations** (D-34). We do not invent a legacy database to migrate
  from. Every migration follows the rules that make it safe on a live table, and
  [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) explains how it rolls out to 60+ tenants.

---

## 13b. Drizzle: generate with drizzle-kit, apply with our runner

**Decision.** Drizzle ORM for the schema and queries, drizzle-zod for request schemas, drizzle-kit to
generate and check migrations. Our runner applies them.

**Rejected.** Hand-written SQL everywhere (what phases 0–2 did), and drizzle-kit `migrate`.

**Why.** Defining the schema once and deriving types, validation and migrations from it removes a
whole class of drift. But drizzle's migrator, read in its source, runs every pending migration in
one transaction (no `CREATE INDEX CONCURRENTLY`), detects pending migrations only from the last
applied timestamp (edited files go unnoticed, out-of-order files are skipped), and takes no lock.
Those four gaps are exactly what a migration against live data cannot afford, so only they are
custom.

**Cost.** Two tools around migrations instead of one, and drizzle-kit's devDependency carries four
moderate advisories from esbuild's development server, which drizzle-kit does not run; the
production tree audits clean.

**What would reverse it.** A drizzle-kit release whose migrator supports per-migration transactions,
checksums and a lock. Then the runner is deleted.

---

## 14. Deliberate deviations from the brief

1. **`amount_minor` in the database.** `amount_cents` is wrong for JPY (0 decimals) and KWD (3). The
   API still accepts and returns `amount_cents`, so nothing breaks for an integrated bank.
2. **The report orders by `amount_base_minor`.** Raw minor units across currencies are not money.
3. **`actor_type` has a third value, `system`.** The sweeper is neither a human nor an agent.
4. **Rule 1 requires "no evidence before the deadline".** Literally applied, it would auto-lose cases
   that answered in time.
5. **The report adds `breached` rows and a `deadline_state` column, and lists the actionable states
   by default.** The brief's exact set is `?state=at_risk,responded`; every state is always counted
   in `summary` (§7c).

Each is reversible at low cost.

---

## 14b. No version in the path, for continuity of service

**Decision.** The paths stay as the brief names them: `/cases/:id`, not `/v1/cases/:id` (D-27).

**Why.** A major version in the path is the better design for a new API, because a breaking change
then has somewhere to go. But this API is not new to its consumers: the brief says banks already
consume `GET /cases/:id` and asks to keep it working. Moving every path under `/v1` would be the
breaking change that versioning exists to prevent.

**What protects the banks instead.** Changes are additive only, and three contracts written by hand
(case, history, report) fail the build if a published field is removed, renamed or retyped (D-41).

**Cost.** There is no place for a breaking change today. When one is needed, the new shape is
published under `/v2/...` beside the current paths, which stay as they are; serving the current
ones under `/v1/...` as well, as an alias, would be additive and can be done at any time.

---

## 15. Simplified for the exercise, to revisit for production

| Area | Exercise | Production |
| --- | --- | --- |
| FX | Static `fx_rates` seeded by migration | Rate source agreed with the business: scheme settlement rates versus the bank's provisioning rates, and how merchants and acquirers report |
| Deadline zone | `UTC` default per window | Confirmed against each scheme's rulebook |
| Auth | Locally minted HS256 tokens (`hono/jwt`) | OIDC with a JWKS via `hono/jwt`'s `verifyWithJwks`, no new dependency |
| Retroactive rulings | Not implemented (`DEADLINE_REVISED` reserved) | Audited batch that appends events |
| Voiding a case | Not implemented (`CASE_VOIDED` reserved) | Event-based soft delete, never a row delete |
| Tamper evidence | Gapless `seq` | Optional hash chain across events |
| Monitoring | Signals sent through `src/monitoring` to Sentry, checked against a local stand-in ([`SLOS.md`](./SLOS.md)) | The monitors and their routing configured in the team's Sentry, and a way to read the objectives through the API when no provider is connected |
| Invariant 3 audit | Run by hand (14 s on 10M cases) | A scheduled audit that pages on a mismatch |
| UI | One static page over the public API, development only (§16) | A frontend application: React with a component kit, its own build, real sign-in |

---

## 16. The console: one static page, not a frontend application

**Decision.** The brief's optional console is one HTML page served by the API at `/console`, made
interactive with Alpine.js and styled with Pico.css, both served from `node_modules`. It calls the
public API from the browser with a token the user pastes (D-52).

**Why.** The brief asks for "a one-page console (at-risk table + case history timeline)" and says
to use libraries rather than write visual design. This gives exactly that with the least there is
to run and explain:

| | This console | A frontend application (React + Vite + a component kit) |
| --- | --- | --- |
| To run it | Nothing new: the API serves it | A second project, a build step, a second server in development |
| Cross-origin | Same origin, no CORS | CORS added to the API, or a proxy |
| Code | One page and one script, about 300 lines | Components, routing, state, a typed API client |
| Typed and linted | No: plain JavaScript in the browser | Yes |
| Component tests | No | Yes |
| Grows well | No | Yes |

It also proves something about the API: the page uses only what a bank would, three endpoints and
no private one, so the published contract is enough to build a client on.

**When this stops being the right choice.** For a frontend that analysts work in all day, the
right-hand column is the answer: React with a component kit, a client generated from the OpenAPI
document the API already serves, real sign-in, and tests. The left column was chosen because this
is a technical exercise and the console is a way to look at the system, not a product.

**Cost.**

- The page's script is not type-checked or linted (it is outside the TypeScript project); a
  renamed response field would break it silently. The frozen contracts make that rename fail the
  build on the API side, which is the protection it has.
- The token is pasted by hand and kept for the browser tab only. There is no sign-in because there
  is no identity provider (§15); the console is not served in production.
- It is read-only: no evidence, outcome or note can be recorded from it.
- **It shows what the API returns and nothing more.** A trend over time (cases expiring per day,
  losses per week) and the service level (the objectives in [`SLOS.md`](./SLOS.md)) are not on the
  page because no endpoint provides them: the report is a snapshot, and the objectives are pushed
  to the monitoring provider. Showing either means a new endpoint first, not more page.

