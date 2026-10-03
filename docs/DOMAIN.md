# Domain Model

How a dispute case behaves, written so it can be read without reading the code. The schema that
enforces it is in [`../migrations`](../migrations) (phase 1); the rules themselves are pure
TypeScript in [`../src/domain`](../src/domain) (phase 2). The domain never reads a clock: every
decision takes `now` as an argument, and ESLint rejects `new Date()`, `Date.now()` and
`Math.random()` there. Time-zone arithmetic uses the runtime's `Intl` time-zone data.

Trade-offs and rejected alternatives are in [`TRADEOFFS.md`](./TRADEOFFS.md). Decision IDs (`D-n`)
refer to the register in [`../NOTES.md`](../NOTES.md) section 3.

---

## Glossary

| Term | Meaning |
| --- | --- |
| **Case** | One dispute the bank must answer to a card scheme. Identified by the platform `id`, and by `external_ref`, the bank's own case id, unique per tenant. |
| **Presentment** | The scheme presenting the dispute to the bank. `presentment_date` is a calendar date in the scheme's calendar; the clock starts there. |
| **Scheme** | `VISA`, `MASTERCARD`, or `OTHER`. |
| **Reason code** | The scheme's code for *why* the cardholder disputed. Together with the scheme it selects the response window. |
| **Response window** | How many days the bank has to answer. Data, not code, because schemes reissue them. Defaults: Visa 45, Mastercard 45, `OTHER` 30. |
| **Deadline** | The instant the response window closes. Missing it is an automatic loss. |
| **Evidence** | The bank's answer to the scheme. Filing it before the deadline is what keeps the case alive. |
| **Outcome** | The scheme's decision: the bank won or lost. Usually arrives weeks *after* the deadline. |
| **At risk** | Not yet answered and the deadline falls inside the risk window (default 7 days). |
| **Breached** | Lost because the deadline passed without evidence. |
| **Stuck queue** | The at-risk and recently breached cases of a tenant, ordered by money. |
| **Tenant** | A bank. One seeded today, 60+ in the target shape. |

---

## States

```
               create
                 │
                 ▼
               OPEN ──────────────── evidence filed before the deadline ───► UNDER_REVIEW
                 │  │                                                          │
                 │  └── scheme outcome (e.g. bank accepts liability) ──┐      │ scheme outcome
                 │                                                      ▼      ▼
                 └── deadline passed, no evidence (system) ──────►  LOST     WON / LOST
```

- Four states only: `OPEN`, `UNDER_REVIEW`, `WON`, `LOST`.
- `WON` and `LOST` are **terminal and absorbing**. Nothing leaves them.
- `UNDER_REVIEW` means *evidence was filed in time*. A case in `UNDER_REVIEW` can no longer lose to
  the deadline; it waits for the scheme.
- There is no path back to `OPEN` in v1 (withdrawing evidence is out of scope).

---

## Terminal rules

The brief's ordered rules, with their predicates made precise. As literally written, rule 1
("deadline passed → LOST") would auto-lose every case whose evidence was filed in time, because the
scheme outcome normally arrives after the deadline; and with first-match evaluation rule 2 would
always shadow rule 3. Both defects are fixed by the predicates below (NOTES 2.10).

| # | `rule_key` | Predicate | Result | Actor |
| --- | --- | --- | --- | --- |
| 1 | `deadline_passed` | deadline passed **and no evidence filed before the deadline** | `LOST` | `system` |
| 2 | `evidence_filed` | evidence filed before the deadline **and no outcome yet** | `UNDER_REVIEW` | `human` / `agent` |
| 3 | `scheme_outcome` | the scheme recorded an outcome | `WON` / `LOST` | `human` / `agent` |
| 4 | `default_open` | otherwise | `OPEN` | — |

- Predicates 2 and 3 cannot both hold, so their order does not matter. The order only decides the
  contradictory case of rule 1 against rule 3, and rule 1 wins: a bank that never answered cannot
  win. In practice the case is already `LOST` by then and the outcome is rejected as a transition
  out of a terminal state.
- Predicates live in code (`src/domain`). Order and enablement per tenant live in
  `tenant_rule_config` (D-8). An empty config means the default order above.
- **Rules run on write only**: when a case is created, when a transition is requested, and when the
  sweeper finds an expired deadline. The decision is stored on the event as `to_status`, `rule_key`
  and `ruleset_version`. Reading history never re-evaluates a rule (D-11).

---

## Clocks and time zones

| Value | Clock | Notes |
| --- | --- | --- |
| `recorded_at` | **PostgreSQL `now()`**, forced by a trigger | One clock for every app instance. Orders and filters history. |
| `occurred_at` | business time of the fact | Equals `recorded_at` for every client event; a client **cannot** send it. Only `DEADLINE_EXPIRED` differs: it carries `deadline_at`. |
| `deadline_at` | computed at creation | See below. |
| "now" in a rule | the transaction's `now()` | The application reads it inside the same transaction that writes the event, so the check and the stamp agree. |

**Deadline.** `deadline_at` is the end of the calendar day `presentment_date + window_days`, in the
time zone of the response window (`response_windows.deadline_tz`, default `UTC`). Formally, the start
of day `presentment_date + window_days + 1` in that zone. In-window means `instant < deadline_at`, a
half-open interval, everywhere (D-6).

- The anchor is the **scheme's** calendar, not the tenant's and not the cardholder's. Payments are
  worldwide, but the obligation is between the issuer and the scheme.
- `UTC` is a default to be confirmed per scheme rulebook. A scheme that anchors elsewhere changes one
  row, by migration. UTC also removes daylight-saving shifts.
- The tenant's `display_timezone` is presentation only.
- All API timestamps are ISO-8601 in UTC (`...Z`). A timestamp without an offset is rejected.

---

## Entities

All of them are in the migrations; this is the reading guide.

### `tenants`

`id`, `name`, `base_currency`, `display_timezone`. The base currency is what the stuck-queue report
sums and orders in.

### `response_windows`

`scheme`, `reason_code` (NULL = scheme default), `window_days`, `deadline_tz`.
`UNIQUE NULLS NOT DISTINCT (scheme, reason_code)`, so resolution always has exactly one answer:
the row for the reason code if it exists, otherwise the scheme default. Changed only by migration,
so git history is its audit trail. No effective dating: cases snapshot the window, so a change never
moves an existing deadline (D-3).

### `fx_rates`

`currency`, `base_currency`, `rate`, `rate_date`. A fixed table, snapshotted onto the case, so the
report is reproducible. Deliberately minimal for the exercise (D-5).

### `cases`: the read projection

| Group | Columns |
| --- | --- |
| Identity | `id`, `tenant_id`, `external_ref` (unique per tenant) |
| Money | `amount_minor`, `currency`, `amount_base_minor`, `base_currency`, `fx_rate`, `fx_rate_date` |
| Dispute | `scheme`, `reason_code`, `presentment_date` |
| Deadline snapshot | `deadline_at`, `deadline_window_id`, `deadline_window_days`, `deadline_tz` |
| State | `status`, `decided_by_rule`, `version` |
| Bookkeeping | `created_at`, `updated_at` |

Only `status`, `decided_by_rule`, `version` and `updated_at` can ever be updated, enforced by a
column-level grant. Everything else is fixed at creation.

### `case_events`: the truth

`case_id`, `seq`, `tenant_id`, `event_type`, `actor_type`, `actor_id`, `from_status`, `to_status`,
`rule_key`, `ruleset_version`, `reason`, `metadata`, `occurred_at`, `recorded_at`.
Primary key `(case_id, seq)`.

**Append-only, enforced three ways** (D-10):

1. The application role `triple_app` has `SELECT` and `INSERT` only.
2. A trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` for every role, including the owner.
3. The foreign key to `cases` is `ON DELETE RESTRICT`: a case with events cannot be deleted.

The only acceptable form of "deleting" a case in the future is a `CASE_VOIDED` event that marks the
projection and keeps everything; it is not in v1.

**`seq`** comes from `cases.version` (D-26): every write does
`UPDATE cases SET ..., version = version + 1 RETURNING version` and the event takes that number. The
row lock taken by the update serialises concurrent writes to the same case, so `seq` is `1..n`
without gaps, and a gap would reveal a deleted event.

### `tenant_rule_config`

`tenant_id`, `rule_key`, `enabled`, `priority`. Order and enablement as data, predicates in code.

### Event catalogue (v1)

| `event_type` | Actor | Status change | `metadata` | Why it exists |
| --- | --- | --- | --- | --- |
| `CASE_CREATED` | human / agent | → `OPEN` | `{ source: "api" }` | Start of the trail. |
| `EVIDENCE_FILED` | human / agent | `OPEN` → `UNDER_REVIEW` | `{ evidence_refs[] }` (references, never files) | Rule 2. |
| `SCHEME_OUTCOME_RECORDED` | human / agent | `OPEN` / `UNDER_REVIEW` → `WON` / `LOST` | `{ outcome, scheme_decision_ref, scheme_decided_on }` | Rule 3. |
| `DEADLINE_EXPIRED` | system | `OPEN` → `LOST` | `{ deadline_at, window_days, detected_by: creation \| sweeper, sweep_run_id? }` | Rule 1. `occurred_at = deadline_at`. |
| `NOTE_ADDED` | human / agent | none (`from = to`) | `{ text }` ≤ 2 KB, no personal data by policy | See below. |

**Why `NOTE_ADDED`.** The brief asks "who or what changed it". Status events only say *when* the
status moved. Notes record the work in between ("requested proof of delivery from the merchant"), and
they are what makes a case with 400 events realistic (review scenario 3): with absorbing terminal
states, status events alone cap a case at three.

Defined but not implemented in v1: `DEADLINE_REVISED` (a retroactive regulator ruling) and
`CASE_VOIDED`. Adding either is a migration that extends a `CHECK`.

`metadata` is validated per `event_type` by a closed `z.discriminatedUnion` in the application, and
the database caps it at 16 KB and requires an object.

### Actors

`actor_type` comes from the verified token, never from the request body:

| Token | `actor_type` | `actor_id` |
| --- | --- | --- |
| user token | `human` | the user's `sub` |
| machine client token | `agent` | the client id |
| — | `system` | `deadline-sweeper`; never accepted from the API |

The database enforces that `system` is used for `DEADLINE_EXPIRED` and nothing else.

---

## HTTP contract

Unversioned paths, as in the brief, because banks already consume `GET /cases/:id` (D-27). Changes
are additive only.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/cases` | Create. Idempotent on `(tenant, external_ref)`. |
| `GET` | `/cases/:id` | Current state, from the projection. |
| `GET` | `/cases?external_ref=...` | Look up by the bank's own id. |
| `POST` | `/cases/:id/transitions` | `{ to, reason, evidence? }` → a domain event. |
| `POST` | `/cases/:id/notes` | `{ text }` → `NOTE_ADDED`. |
| `GET` | `/cases/:id/history?as_of=` | Replay at an instant, default now. |
| `GET` | `/reports/stuck-queue?risk_window_days=7` | The stuck-queue report. |

**Money fields.** The column is `amount_minor`. The API accepts and returns `amount_cents`, the
brief's name, with the same value, and additionally returns `amount_minor` and `currency_exponent`.
`amount_cents` is documented as deprecated but never removed while a bank reads it.

**Transitions.** The client keeps the brief's vocabulary; the server records a fact:

| `to` | Recorded as | Allowed when | Otherwise |
| --- | --- | --- | --- |
| `UNDER_REVIEW` | `EVIDENCE_FILED` | status is `OPEN` and `now < deadline_at` | `409`, naming the rule |
| `WON` / `LOST` | `SCHEME_OUTCOME_RECORDED` | status is not terminal | `409 case_closed` |
| `OPEN` | — | never: it is the default, not an action | `422` |
| same as current | nothing | always | `200`, no new event (safe retry) |

The rules always win, and never silently: if the evaluated status differs from the requested one,
the request is rejected with the rule that decided, and nothing is written.

---

## Flows

### Create a case

```
POST /cases
  ├─ validate the body against the endpoint schema
  ├─ tenant and actor from the verified token            (never from the request)
  ├─ existing (tenant, external_ref)? same payload → 200 with it; different → 409
  ├─ resolve the response window (reason code, else scheme default)
  ├─ deadline_at = end of day (presentment_date + window_days) in deadline_tz
  ├─ amount_base_minor from fx_rates, snapshotted
  ├─ insert cases (version 1) and CASE_CREATED (seq 1)
  └─ evaluate rules at the transaction's now():
       deadline already passed → DEADLINE_EXPIRED (seq 2, occurred_at = deadline_at), status LOST
```

Evaluating at creation makes review scenario 2 deterministic: a case presented 50 days ago is `LOST`
the moment it is created, not whenever the sweeper next runs (D-28).

### Transition a case

```
POST /cases/:id/transitions
  ├─ load the case for the token's tenant, FOR UPDATE      (404 if another tenant's)
  ├─ map `to` to a domain event, evaluate the rules at now()
  ├─ evaluated status ≠ requested → 409 with the deciding rule, nothing written
  ├─ UPDATE cases SET status, decided_by_rule, version = version + 1 RETURNING version
  └─ INSERT case_events with seq = that version              (same transaction)
```

### Fetch history as of an instant

```
GET /cases/:id/history?as_of=2025-03-01T00:00:00Z
  ├─ events with recorded_at <= as_of, ordered by seq
  ├─ fold: state = the to_status of the last event          (no rule evaluation)
  └─ return state, decided_by, the events themselves, truncated flag
```

```json
{
  "case_id": "…",
  "as_of": "2025-03-01T00:00:00Z",
  "state": { "status": "UNDER_REVIEW", "deadline_at": "…", "version": 3 },
  "decided_by": { "seq": 3, "rule_key": "evidence_filed", "ruleset_version": 1 },
  "events": [
    {
      "seq": 1, "type": "CASE_CREATED", "from": null, "to": "OPEN",
      "actor": { "type": "human", "id": "…" },
      "occurred_at": "…", "recorded_at": "…", "reason": "…", "metadata": {}
    }
  ],
  "truncated": false
}
```

- `as_of` answers "what did the record say at that instant". Between a deadline and the sweep that
  records it, history truthfully shows `OPEN`; the `DEADLINE_EXPIRED` event then carries the
  deadline as its `occurred_at`.
- `as_of` before the case existed returns `200` with `state: null`: "it did not exist yet" is a valid
  answer to a regulator.
- The 50 000-event cap and `truncated` flag stay as a guard; 400 events is far below it.

### Sweep for expired deadlines

```
every SWEEP_INTERVAL_MS (default 60 s)
  ├─ SELECT … WHERE status = 'OPEN' AND deadline_at <= now() FOR UPDATE SKIP LOCKED LIMIT n
  ├─ for each: version + 1, DEADLINE_EXPIRED (system, occurred_at = deadline_at), status LOST
  └─ commit per batch
```

Only `OPEN`: `UNDER_REVIEW` cannot lose to the deadline. Idempotent, because a swept case is no
longer `OPEN`. `SKIP LOCKED` lets several workers run without contending.

### Stuck-queue report

```
GET /reports/stuck-queue?risk_window_days=7&limit=50&cursor=…
  at_risk:  status IN ('OPEN','UNDER_REVIEW') AND deadline_at <= now() + risk_window   (the brief)
  breached: status = 'LOST' AND decided_by_rule = 'deadline_passed'
            AND deadline_at >= now() - risk_window
  UNION ALL, ORDER BY amount_base_minor DESC, id; keyset pagination on (amount_base_minor, id)
```

Each row carries `deadline_state`:

| `deadline_state` | Meaning |
| --- | --- |
| `at_risk` | `OPEN`, deadline inside the window: act now. |
| `responded` | `UNDER_REVIEW`: in the brief's filter, but evidence is already filed. |
| `breached` | Lost to the deadline within the lookback: money already lost. |

The brief's filter is kept verbatim for `at_risk` and `responded`; `breached` is an addition (D-28).

---

## Invariants

Each is a property a test asserts, not a comment. Schema-level ones are tested in
`test/schema.integration.test.ts`, domain-level ones in `test/domain/`.

1. `case_events` is append-only. *(schema: grants, trigger, FK — tested)*
2. Every event has an actor; `system` only for `DEADLINE_EXPIRED`. *(schema — tested)*
3. `cases.status` equals the `to_status` of the case's last event, and `cases.version` equals its
   highest `seq`. Checkable for the whole table with one query. *(domain: `projectionMatchesLog` —
   tested)*
4. `deadline_at` and the window snapshot are set at creation and never change in v1. *(schema:
   column grant — tested)*
5. Reading history never evaluates a rule. It folds stored events with `recorded_at <= as_of`, by
   `seq`. *(domain: `foldHistory` takes no rules; tested with a decision today's rules would not
   make)*
6. In-window is `instant < deadline_at`, half-open, defined once in `src/domain/deadline/deadline.ts`.
   *(domain: 1 ms before, at, and after — tested)*
7. A tenant comes from the verified claim only. A cross-tenant read returns `404`, not `403`.
8. Money is integer minor units plus a currency. No floating point touches an amount. *(domain:
   `bigint` throughout `src/domain/money` — tested)*
9. Every write to `cases` writes an event in the same transaction, with `seq = version`.
10. `recorded_at` is the database clock; clients cannot backdate. *(schema: trigger + check — tested)*

---

## Use cases

| Actor | Use case | Flow |
| --- | --- | --- |
| Bank integration | Register a newly presented dispute | Create |
| Bank integration | Read a case's current state | `GET /cases/:id` |
| Operations analyst | File evidence before the deadline | Transition to `UNDER_REVIEW` |
| Operations analyst | Record the scheme's decision | Transition to `WON` / `LOST` |
| Operations analyst | Record work done on a case | Note |
| Operations analyst | See what is about to auto-lose, by money | Stuck-queue report |
| Counterparty or regulator | Reconstruct a case as it stood on a past date | History `as_of` |
| System | Record an automatic loss when a deadline passes | Sweep |
| Platform operator | Change a response window or a tenant's rule order | Migration |

---

## Out of scope for v1

Outbound scheme integrations, a rules admin API, evidence file storage, case assignment workflows,
withdrawing evidence, voiding cases, retroactive deadline revisions, and a UI. Each is either not in
the brief or adds credentials or an admin surface to the critical path.
