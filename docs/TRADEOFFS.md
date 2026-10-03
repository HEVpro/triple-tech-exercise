# Trade-offs

The brief ends with: *"We will spend our first 45 minutes debating the trade-offs behind these."* This
document is written to be that conversation, including the parts where the choice is uncomfortable.

Every entry states the decision, the alternative that was rejected, why, what the choice costs, and
what evidence would reverse it. The full register with dates and context is in
[`../NOTES.md`](../NOTES.md) section 3.

---

## 1. The four review scenarios, and what each one actually tests

| # | Scenario | What it is really testing | Our answer |
| --- | --- | --- | --- |
| 1 | Visa, presentment 40 days ago, `OPEN` → at-risk, deadline in 5d | Whether the deadline is computed in the tenant's calendar rather than UTC | Deadline resolves at end of day, tenant timezone; 40 + 45 = day 45, so 5 days of runway remain and rule 1 does not fire |
| 2 | Mastercard, presentment 50 days ago, `OPEN` → breached | Whether time-driven status change works at all without a human | Rule 1 fires from the sweeper, `system` actor, LOST |
| 3 | 400 events, opened 2 years ago, history under 200ms | Whether the audit trail is the source of truth or a decoration | Events are the truth; 400 events is a rounding error, the cost driver is the indexed read |
| 4 | ~10M rows, report under 100ms, with `EXPLAIN` | Whether performance claims are measured or asserted | Deferred to phase 6 with a partial index and a recorded plan |

Scenario 4 is the one that cannot be answered in a design document. It is answered by producing
`EXPLAIN (ANALYZE, BUFFERS)` output and attaching it. Until that exists, every performance statement
in this repository is an intention rather than a claim.

---

## 2. Audit trail: event sourcing versus a status column

**Decision.** `case_events` is the append-only source of truth. `cases.status` is a read projection
written in the same transaction.

**Rejected.** A `status` column updated in place, with an optional audit table written best-effort.

**Why.** The brief asks to *"answer what was this case on day X, and who or what changed it?"* and to
reconstruct history years later. A status column cannot answer that: once it is overwritten, the
prior value exists only if something else recorded it. Making events the truth makes `as_of`
replay correct by construction rather than by careful maintenance.

**Cost.** Every read has two paths, current state and replay, and they can disagree. Every write pays
for the projection. This is roughly a factor of two in code volume on the read side versus a mutable
model, and it is the single largest complexity decision in the project.

**What would reverse it.** If replay latency ever breached the SLO at realistic event counts, the
projection could become a materialised view refreshed on a schedule, trading point-in-time accuracy
for read speed. The cap and `truncated` flag in D-11 already exist so this remains possible without a
schema change.

---

## 3. Deadlines: snapshot the window, or recompute it every read

**Decision.** `response_windows` is effective-dated, and the resolved window is **snapshotted onto
the case** at creation (`deadline_at`, `deadline_window_version`, `deadline_basis`). A retroactive
regulator ruling is a versioned batch that appends `DEADLINE_REVISED` events.

**Rejected.** Recomputing `deadline_at` from the current `response_windows` row on every read.

**Why.** Payment schemes judge a dispute under the rules in force at presentment. If a regulator
reissues a window from 45 to 60 days, the cases already in flight keep the 45-day deadline they were
filed under, which is both legally correct and operationally explainable. Recomputing on read would
retroactively move deadlines on live cases with no event and no audit entry.

**Cost.** The snapshot is denormalised state that must be written correctly at creation and versioned
when changed. Two sources of truth for a deadline exist, and the resolution rule, *snapshot first,
fall back to the window table*, has to be stated explicitly in the domain module.

**What would reverse it.** A ruling with explicit retroactive application to open cases. That is
supported, and it is an audited batch rather than a silent mutation.

---

## 4. Money: integer minor units, and a fixed FX rate

**Decision.** `amount_minor BIGINT` plus `currency CHAR(3)`, scaled by an ISO 4217 exponent map. The
report additionally materialises `amount_base_minor`, `base_currency`, `fx_rate`, `fx_rate_date` at
case creation from a fixed, versioned, effective-dated FX table.

**Rejected.** `double precision`; `NUMERIC`; a fixed two-decimal convention; and, for the report, a
live FX lookup at query time.

**Why.** `amount_cents` in the brief is a domain defect. JPY has zero decimal places and KWD has
three, so a field named `cents` cannot represent a correct amount. `INT` overflows at roughly 21M,
which a portfolio total can reach, so `BIGINT` is the floor, not a luxury. Floating point cannot
represent 0.1 and would put rounding error into a number that ends up in a regulatory filing.

For the report, sorting raw minor units across currencies ranks a KWD amount below a JPY amount and
inverts the meaning of *"where are we losing money"*. Normalising to a base currency at creation makes
the ordering meaningful, and fixing the rate makes the number reproducible: a report whose total
changes because the FX market moved cannot be audited or defended.

**Cost.** `NUMERIC` was rejected for performance and simplicity, which is a real trade: `NUMERIC` is
exact for the same money and some teams should prefer it. A fixed rate table is also operationally
awkward, since someone has to maintain it, and it is only correct because it represents *contractual*
provisioning rates rather than spot rates.

**What would reverse it.** Exposure reported per currency with no base total, which removes the need
for normalisation and makes the FX table unnecessary. That is a reporting change, not a schema change.

---

## 5. The deadline boundary: half-open interval, tenant timezone

**Decision.** `deadline_at` is end of day `(presentment_date + window_days)` in the tenant's IANA
timezone, computed with `DATE` arithmetic and then localised. In-window is `event_at < deadline_at`.

**Rejected.** UTC arithmetic; storing only a `DATE`; a closed interval `event_at <= deadline_at`.

**Why.** The scheme deadline is anchored to the bank's calendar day, so UTC arithmetic silently
grants up to 14 extra hours to a tenant east of Greenwich. `DATE + 45` followed by `AT TIME ZONE` is
DST-safe, where `timestamptz + interval '45 days'` shifts by an hour across a 23- or 25-hour day. A
half-open interval removes the question of whether an event exactly at the deadline is inside or
outside; with a closed interval, the same event has two defensible answers and only one of them can
be implemented.

**Cost.** End-of-day deadlines are less precise than they sound, and the stored instant is not what
an operations analyst means by "the deadline". The half-open rule has to be documented for every
consumer or it will be re-implemented wrong somewhere. Both are accepted deliberately.

**What would reverse it.** Nothing in the brief asks for sub-day deadline precision, and the scheme
rules do not provide it.

---

## 6. Terminal rules: predicates in code, not a table or a DSL

**Decision.** Terminal rule predicates are TypeScript functions in `src/domain`. `tenant_rule_config`
holds only enablement and priority per tenant. No admin API in v1.

**Rejected.** A table-driven rules engine with predicates as SQL or as a small DSL; and the opposite
extreme of everything hardcoded in code with no per-tenant data at all.

**Why.** The dangerous part of a rules engine is text that gets evaluated, because that implies an
admin surface which can be injected into or used for privilege escalation, and it is also the part
that is hardest to test. The genuinely useful part is ordering and per-tenant enablement, which is
plain data and can be changed by a migration with a reviewable diff. Predicates in code are unit
testable without a database and appear in coverage reports.

**Cost.** Changing a rule requires a deploy. Rules cannot be tuned per tenant in real time. This is a
deliberate reversal of what a rules platform normally prioritises, and it is the decision most likely
to be challenged in review. The answer to that challenge is the brief's own priority ordering: an
auditable, testable rule beats a flexible one for a system that a regulator will audit.

**What would reverse it.** A demonstrated need for per-tenant thresholds without a deploy, such as a
large tenant operating under a scheme rule that differs from everyone else's. The `tenant_rule_config`
table is the seam where that would be added.

---

## 7. Deadline expiry: a sweeper, not lazy evaluation

**Decision.** A periodic batch sweeper, `SWEEP_INTERVAL_MS` default 60 s, `FOR UPDATE SKIP LOCKED`,
idempotent, appending events with a `system` actor.

**Rejected.** Computing the status on read; `pg_cron`; doing nothing.

**Why.** A case sitting in `OPEN` generates no event when the clock passes its deadline, so
lazy evaluation would recompute on every read and still leave the stored status wrong for every other
consumer, including the report. Idempotency is free here precisely because the events are the truth
and the status is a projection: running twice appends nothing new. `SKIP LOCKED` is what lets several
workers run without contending.

**Cost.** A background process to deploy, monitor and alert on, and a window during which the status
is up to 60 seconds stale. That window is an SLO, not an implementation detail, and it is why D-22
makes the interval configurable.

**What would reverse it.** Per-tenant urgency. A tenant whose windows are 3 days rather than 45 could
require a shorter sweep interval, which argues for a per-tenant interval eventually.

---

## 8. Multi-tenancy: single tenant as a stated hypothesis

**Decision.** `tenant_id` on every business table, one seeded tenant, and the tenant taken *only* from
the verified JWT claim. No header, no body field, no query parameter.

**Rejected.** Full multi-tenant isolation machinery built now; and dev headers for tenant identity.

**Why.** The brief asks for a migration plan against *"live data for 60+ tenants"*, so the target shape
is known. `tenant_id` on every table and a claim-derived tenant cost nothing now and make 60 tenants a
seeding change rather than a rewrite. Dev headers are the reason cross-tenant leaks exist in most
systems that have them: they are harmless in testing and poisonous in an integration.

**Cost.** A claim that the design is multi-tenant while running one tenant invites the question of
whether it has actually been tested, which is why phase 4 requires an explicit cross-tenant test that
fails if the tenant is read from anywhere except the verified claim.

**What would reverse it.** Nothing. This is the cheap direction to be wrong in.

---

## 9. Storage: no partitioning, yet

**Decision.** No partitioning. The decision is deferred to evidence: `EXPLAIN (ANALYZE, BUFFERS)` and
vacuum/bloat analysis on a 2M-row fixture, with the revisit triggers recorded.

**Rejected.** Range partitioning `case_events` by `occurred_at` up front.

**Why.** Every query in this system is tenant-scoped and index-backed. Partitioning helps time-based
deletion and very large global aggregates; it does not assist a point lookup or a per-tenant scan.
Adopting it reflexively would multiply the DDL object count by roughly 60 and complicate every future
migration, while making no hot query faster.

**Cost.** If phase 6 shows that per-tenant table growth is the actual bottleneck, this decision is
reversed late, and retro-partitioning a live table is one of the most expensive operations in
PostgreSQL. That risk is real and is the reason the revisit triggers are written down rather than
left to memory.

**What would reverse it.** Bloat on `case_events` dominating vacuum time; per-tenant event counts large
enough that index depth hurts; or retention requirements that make deletion the dominant cost.

---

## 10. Migrations: transaction control per migration

**Decision.** The migration runner supports per-migration transaction control, so
`CREATE INDEX CONCURRENTLY` can live inside the migration system.

**Rejected.** A runner that wraps every migration in a transaction, which is the conventional default.

**Why.** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. If the runner forces one, the
only way to add a production index to a live table is by hand outside the migration system, losing
traceability on exactly the artefact the brief asks to be auditable. Auditability is worth more than
runner uniformity.

**Cost.** A partially applied migration is possible, so the runner must record each migration's
completion and checksum separately and support re-running a failed non-transactional migration. The
live-data plan has to state which migrations are safe to run online, which is a real constraint on
the release process.

---

## 11. Rule 1 has an actor the brief did not ask for

**Decision.** `actor_type IN ('human','agent','system')`, with `actor_id` always populated.

**Rejected.** The brief's `human | agent`.

**Why.** The sweeper is not a human and not an agent, and an audit trail with no identity for the
single most consequential transition, an automatic loss to the scheme, is decoration. A regulator
asking who lost the case deserves the answer "the deadline rule, at the scheduled sweep, actor
`system`", not a null.

**Cost.** A three-value enum the brief did not specify, and a migration if the reviewer's integration
expects exactly two.

---

## 12. Event metadata: validated JSONB, with typed columns kept

**Decision.** `case_events.metadata JSONB NOT NULL DEFAULT '{}'`, validated per `event_type` by a
`z.discriminatedUnion`, capped at 16 KB, no PII. Everything that is queried stays a typed column.

**Rejected.** Free-form unvalidated JSONB; adding a typed column for every attribute; indexing into
the JSONB at 10M rows.

**Why.** Adding an attribute to an event should not require a migration across 60 tenants, which is
exactly what typed columns would force. Unvalidated JSONB accepts typos silently and makes the audit
trail undemonstrable. A closed union turns "append-only" from a convention into a type. The 16 KB cap
stops a single event from bloating the table, and banning PII keeps append-only compatible with the
erasure obligations a real bank has.

**Cost.** JSONB is slower to query than a column and costs more on disk. Anything that turns out to
need indexing must be promoted to a column, and that promotion is a migration.

---

## 13. Deliberate deviations from the brief

Three places where this implementation does not literally do what the brief says. All three are
raised explicitly so they are decisions rather than oversights:

1. **`amount_cents` is `amount_minor`.** The brief's name is a defect; JPY and KWD prove it.
2. **The report orders by `amount_base_minor`, not `amount_cents`.** Sorting minor units across
   currencies is not sorting by money. The base amount is materialised at creation from a fixed rate.
3. **`actor_type` has a third value, `system`.** The sweeper cannot honestly claim to be a human.

Each is reversible at low cost: a rename, an extra ordering column, or an enum value.