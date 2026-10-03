# Performance

Measurements behind review scenarios 3 and 4, and how to reproduce them. Phase 4 measured them on a
million cases; phase 5 completes this document (see [What is still open](#what-is-still-open)).

## How to reproduce

```bash
npm run db:up && npm run db:migrate && npm run dev:seed
npm run seed:perf        # 1M cases and 2.8M events into the development database, ~1 min
npm run perf:explain     # EXPLAIN (ANALYZE, BUFFERS) of the SQL the API actually runs
```

`perf:explain` does not contain SQL of its own: it runs the real use cases through the real Drizzle
adapter, captures the statements Drizzle sends, and re-runs each under `EXPLAIN (ANALYZE, BUFFERS)`
with the same parameters. A plan in this document is therefore the plan of the query in production
code, not of a hand-written copy.

## The data

`npm run seed:perf`, 1 000 000 cases plus one 400-event case, 2 788 193 events:

| | Acme (dev tenant, EUR) | 20 other tenants |
| --- | --- | --- |
| Cases | 799 413 | 200 588 |
| `OPEN` | 19 870 | 4 859 |
| `UNDER_REVIEW` | 14 972 | 3 619 |
| `WON` / `LOST` | 764 571 | 192 110 |

Presentments over three years, so most cases are closed and open work clusters in the last response
window, which is what a real portfolio looks like. Every case has the events that explain its
status (invariant 3 holds). Measured on a laptop, PostgreSQL 17 in Docker, default settings from
`docker-compose.yml` (`shared_buffers=256MB`).

## Results

### Scenario 4: stuck-queue report for a large tenant (target < 100 ms)

For Acme: 3 008 cases at risk, 766 breached in the last 7 days, 5 037 responded.

| Query | Time (database) | Plan |
| --- | --- | --- |
| First page, 50 items | 1.1 ms warm; 3.5–13.7 ms cold | Index-only scans of `cases_queue_idx` and `cases_queue_breached_idx`, `Heap Fetches: 0`, top-N sort, then 51 primary-key lookups |
| Next page (cursor) | 0.9 ms | Same plan, starting after the cursor |
| Summary, all three states | 1.2 ms | Index-only scans, see below |
| `GET /reports/stuck-queue` end to end (HTTP, JSON) | 56 ms, first call | |

Before the phase 4 index, the first page took **32 ms**: the phase 1 index did not cover `id`, so
PostgreSQL read one table block per case at risk (3 478 blocks). An alternative index ordered by
amount took 23 ms, because walking by amount discards thousands of old deadline losses to find last
week's (NOTES 2.24).

### Scenario 3: history of a case with 400 events (target < 200 ms)

| Query | Time | Plan |
| --- | --- | --- |
| Events of `PERF-HISTORY-400`, among 2.8M events | 0.06 ms | Index scan on `case_events_pkey (case_id, seq)` |
| `GET /cases/:id/history` end to end | 14 ms | |

The primary key `(case_id, seq)` is the history index (D-26): finding a case's events costs the same
whether the table holds a thousand events or a billion, plus the 400 rows themselves.

## Why a million, not ten million

The report's latency depends on the size of the at-risk set and on whether the index is in memory,
not on the number of rows in the table; a B-tree gains at most one level between 1M and 10M rows
(TRADEOFFS §10). At 10M, Acme's at-risk set would be about ten times larger, so the top-N sort over
it grows accordingly, still well inside 100 ms on the index-only path. `npm run seed:perf -- --rows
10000000` repeats the measurement at the brief's size.

## What is still open

- **The summary still uses the phase 1 indexes** (`cases_at_risk_idx`, `cases_breached_idx`): they
  are smaller because they lack `id`, so the planner prefers them. Before the contract step drops
  them, the summary's plan on the new indexes must be measured here.
- `Rows Removed by Filter` on the first page: the queue index covers `OPEN` and `UNDER_REVIEW`
  together (so it serves the summary too), and the page filters out the `UNDER_REVIEW` entries it
  reads. Negligible at 1M; to be confirmed at 10M.
- Cold and warm runs measured systematically, and the 10M run, in phase 5.
