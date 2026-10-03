# Domain Model

How a dispute case behaves, written so it can be read without reading the code. The type-level
enforcement of these rules lives in `src/domain`, which does not exist yet; it arrives in phase 2.

Trade-offs and rejected alternatives are in [`TRADEOFFS.md`](./TRADEOFFS.md).

---

## Glossary

| Term | Meaning |
| --- | --- |
| **Case** | One dispute the bank must answer to a card scheme. Identified externally by `external_ref`, the bank's own case id. |
| **Presentment** | The scheme presenting the dispute to the bank. `presentment_date` is the day the clock starts. |
| **Scheme** | Visa, Mastercard, or `OTHER` for anything else in v1. |
| **Reason code** | The scheme's code for *why* the cardholder disputed. Paired with the scheme it selects the response window. |
| **Response window** | How long the bank has to answer. Effective-dated, because schemes reissue them. Defaults: Visa 45 days, Mastercard 45 days, `OTHER` 30 days. |
| **Deadline** | End of day `presentment_date + window_days`, in the tenant's timezone. A missed deadline is an automatic loss. |
| **Evidence** | Something filed in response, before the deadline. |
| **At risk** | Still actionable but inside the risk window: `deadline_at <= now() + risk_window`, default 7 days. |
| **Stuck queue** | All cases that are at risk, ordered by exposure. Where the dispute operation is losing money. |
| **Tenant** | A bank. One today, 60+ in the target shape. |

---

## States

```
   create
      │
      ▼
    OPEN ◄────────────────────────────┐
      │ ▲                             │ 4. else -> OPEN
      │ │                             │
      │ │ 2. evidence filed,          │
      │ │    before the deadline      │
      │ └───────────────────────────► UNDER_REVIEW
      │                                 │
      │ 1. deadline passed (auto)      │ 3. scheme records outcome
      │                                 │
      ▼                                 ▼
   LOST ◄──────────────────────────── WON
```

Only four states exist: `OPEN`, `UNDER_REVIEW`, `WON`, `LOST`. There is no `REJECTED` and no
`EXPIRED`, because losing to the scheme for missing a deadline *is* a loss, and separating the two
would let a case sit in a state that has no business meaning.

Terminal states are `WON` and `LOST`. `OPEN` and `UNDER_REVIEW` are where work accumulates and where
money is at risk.

---

## Terminal rules

Ordered predicates that map events to a status. The evaluation clock is the `as_of` instant being
evaluated, **never** `now()`, except during live sweep evaluation where `as_of` is the sweep time.
That distinction is the difference between a working history endpoint and one that quietly lies
(`NOTES.md` 2.8).

| # | Rule | Result | Actor |
| --- | --- | --- | --- |
| 1 | Deadline passed | `LOST` | `system` |
| 2 | Evidence filed before the deadline | `UNDER_REVIEW` | `human` / `agent` |
| 3 | Scheme records an outcome | `WON` or `LOST` | `human` / `agent` |
| 4 | Otherwise | `OPEN` | — |

Each rule returns the status **and** the rule that produced it, so a status is always explainable.
Rules are ordered because rule 1 must beat rule 3: a case whose deadline passed and then received a
scheme outcome of `WON` is contradictory data, and rule 1 wins so the loss is not erased.

Rule 1 is time-triggered. Nothing happens to a case when the clock passes its deadline, so a sweeper
evaluates it on a schedule. Rules 2 and 3 are event-triggered and evaluated on write.

---

## Entities

### `tenants`

One row per bank: `id`, `name`, `timezone` (IANA), `base_currency`. The timezone exists because a
scheme deadline is a local calendar day, and the base currency exists because exposure has to be
summed across the portfolio.

### `response_windows`

Effective-dated: `scheme`, `reason_code`, `window_days`, `valid_from`, `valid_to`, `version`. Overlap
is forbidden, so resolving the window for a presentment date has exactly one answer.

### `cases`

The read projection. `external_ref`, `tenant_id`, `amount_minor`, `currency`, `scheme`,
`reason_code`, `presentment_date`, `status`, and the deadline snapshot: `deadline_at`,
`deadline_window_version`, `deadline_basis`.

`external_ref` is the bank's own identifier, so the integration contract stays in the bank's terms
rather than ours.

### `case_events`

The truth. Append-only, never updated, never deleted except by cascade from the case.
`case_id`, `seq`, `event_type`, `actor_type`, `actor_id`, `occurred_at`, `from_status`,
`to_status`, `reason`, `metadata JSONB`.

`seq` is a per-case monotonic counter. It exists because timestamps tie, and a replay ordered only by
time is nondeterministic at exactly the boundary where nondeterminism is least acceptable.

`metadata` is validated per `event_type` against a closed union, capped at 16 KB, and carries no PII.

### `tenant_rule_config`

`tenant_id`, `rule_key`, `enabled`, `priority`. Ordering and enablement as data; predicates in code.

---

## Flows

### Create a case

```
POST /v1/cases
      │
      ├─ validate the body against the endpoint schema
      ├─ resolve tenant from the verified token claim        (never from the request)
      ├─ resolve the response window for scheme + reason_code at presentment_date
      ├─ compute deadline_at: end of day (presentment_date + window_days), tenant timezone
      ├─ normalise to base currency at the fixed, dated rate (amount_base_minor, fx_rate, fx_rate_date)
      ├─ insert cases.status = OPEN
      └─ append CASE_CREATED, actor from the token
```

Everything computed here is stored, not recomputed on read. Reasons in
[`TRADEOFFS.md`](./TRADEOFFS.md) sections 3 and 4.

Idempotent on `external_ref` within a tenant, so a retried bank request returns the existing case
instead of creating a second one.

### Transition a case

```
POST /v1/cases/:external_ref/transitions
      │
      ├─ load the case for the token's tenant
      ├─ validate the transition against the state machine
      ├─ append the event (from, to, actor, at, reason, metadata)
      ├─ recompute the status by evaluating the rules in order
      └─ update the projection, in the same transaction
```

The event and the projection are written in one transaction. A half-written transition is worse than
a rejected one, because the status would disagree with the audit trail.

### Fetch history as of an instant

```
GET /v1/cases/:external_ref/history?as_of=2025-03-01T00:00:00Z
      │
      ├─ load all events with occurred_at <= as_of, ordered by (occurred_at, seq)
      ├─ fold them, evaluating the rules with clock = as_of
      └─ return the reconstructed case, its status, the rule that decided it,
         and a truncated flag if the 50 000-event cap was hit
```

Returning the whole reconstructed case, not just the status, means a future `CASE_AMENDED` event needs
no API change.

### Sweep for expired deadlines

```
every SWEEP_INTERVAL_MS (default 60 s)
      │
      ├─ select cases in (OPEN, UNDER_REVIEW) whose deadline_at <= now()
      ├─ lock with FOR UPDATE SKIP LOCKED
      ├─ evaluate rules with clock = sweep time
      ├─ append DEADLINE_EXPIRED, actor_type = system
      └─ update the projection
```

Idempotent by construction: the events are the truth, so a second sweep appends nothing new.
`SKIP LOCKED` is what lets workers run concurrently without contending on the same case.

### Stuck-queue report

```
GET /v1/reports/stuck-queue?risk_window_days=7
      │
      ├─ filter: status IN (OPEN, UNDER_REVIEW)
      │          AND deadline_at <= now() + interval '7 days'
      ├─ order by amount_base_minor DESC
      └─ return rows plus a computed overdue flag
```

Ordered by exposure, not by age. Age tells you what is oldest; the question is where the money is.
`overdue` is computed rather than stored, because it depends on `now()` and a stored flag would be
wrong between sweeps.

---

## Invariants

Each of these is a property the tests must assert, not a comment:

1. `case_events` is append-only. Nothing updates or deletes a row.
2. Every event has an actor. `actor_type` and `actor_id` are always populated.
3. `cases.status` always equals the status obtained by folding the case's events. The projection is
   never the source of truth, and a test compares them.
4. `deadline_at` is derived only at creation, from the snapshot columns on the case.
5. `as_of` evaluation uses `as_of` as the clock, and a test asserts this differs from `now()` for at
   least one fixture.
6. The in-window test is `event_at < deadline_at`, half-open, everywhere. One definition, one place.
7. A tenant comes from the verified claim only. A cross-tenant read returns 404, not 403.
8. Money is integer minor units plus a currency. No floating point arithmetic touches an amount.
9. Every write to `cases` is accompanied by an event in the same transaction.
10. No event metadata contains PII, and no single event exceeds 16 KB.

---

## Use cases

| Actor | Use case | Flow |
| --- | --- | --- |
| Bank integration | Register a newly presented dispute | Create a case |
| Bank integration | Read a case's current state | Fetch a case, projection read |
| Operations analyst | Assign a case to an agent | Transition to `UNDER_REVIEW` |
| Operations analyst | File evidence before the deadline | Transition, rule 2 |
| Counterparty or regulator | Reconstruct a case as it stood on a past date | History as of an instant |
| Operations analyst | See what is about to auto-lose, by exposure | Stuck-queue report |
| System | Record an automatic loss when a deadline passes | Sweep |
| Compliance | Prove when and why a case changed | Event log |
| Platform operator | Decide per-tenant rule ordering | `tenant_rule_config`, by migration |

---

## Out of scope

Notifications to scheme APIs, a rules admin API, evidence file storage, and case assignment
workflows. None are required by the brief, and each would add either credentials on the critical path
or an admin surface (`TRADEOFFS.md` section 6).