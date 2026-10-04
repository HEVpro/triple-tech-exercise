# Performance

Measurements behind review scenarios 3 and 4, and how to reproduce them. Measured twice: on one
million cases in phase 4, when the report index was chosen, and on **ten million** in phase 5, the
size the brief names.

## How to reproduce

```bash
npm run db:up && npm run db:migrate && npm run dev:seed
npm run seed:perf                        # 1M cases and 2.8M events, ~1 min
npm run seed:perf -- --rows 10000000     # 10M cases and 27.9M events, ~21 min, 10 GB
npm run perf:explain                     # EXPLAIN (ANALYZE, BUFFERS) of the SQL the API actually runs
```

The seed runs once per database (the event log is append-only), so the two sizes are two separate
runs, each on a fresh database.

`perf:explain` does not contain SQL of its own: it runs the real use cases through the real Drizzle
adapter, captures the statements Drizzle sends, and re-runs each under `EXPLAIN (ANALYZE, BUFFERS)`
with the same parameters. A plan in this document is therefore the plan of the query in production
code, not of a hand-written copy.

## The data

| | 1M run | 10M run |
| --- | --- | --- |
| Cases | 1 000 001 | 10 000 001 |
| Events | 2 788 193 | 27 878 877 |
| Acme (dev tenant, EUR), cases | 799 413 | 8 000 088 |
| Acme `OPEN` / `UNDER_REVIEW` | 19 870 / 14 972 | 198 927 / 149 619 |
| Acme queue: at risk / breached (7 days) / responded | 3 008 / 766 / 5 037 | 30 726 / 7 655 / 50 781 |
| 20 other tenants, cases | 200 588 | 1 999 913 |
| Database size | 1.1 GB | 10 GB |

Presentments over three years, so most cases are closed and open work clusters in the last response
window, which is what a real portfolio looks like. Every case has the events that explain its
status (invariant 3 holds), plus one case with 400 events. Measured on a laptop (Apple M4, 24 GB),
PostgreSQL 17.11 in Docker Desktop (10 CPUs, 8 GB), settings from `docker-compose.yml`
(`shared_buffers=256MB`).

## Results at 10M

After the contract step that dropped the phase 1 indexes (see below).

### Scenario 4: stuck-queue report for a large tenant (target < 100 ms)

For Acme, 8M cases. Times are `Execution Time` from `EXPLAIN ANALYZE`.

| Query | Repeated on one connection (5 runs) | First run on a new connection (6 runs) | After a PostgreSQL restart |
| --- | --- | --- | --- |
| First page, 50 items | 5.3–6.5 ms | 11.3–13.1 ms | 14.6 ms |
| Next page (cursor) | — | 11.3–12.5 ms | 12.0 ms |
| Summary: at risk and responded | 6.4–7.2 ms | 12.6–14.9 ms | 11.7 ms |
| Summary: breached | 0.6–0.7 ms | 0.5–0.6 ms | 0.6 ms |
| **`GET /reports/stuck-queue` end to end (HTTP, JSON)** | **17–24 ms** | | 44 ms, first call |

- The API keeps a connection pool, so the first column is what a request normally sees; the HTTP row
  is the whole request (auth, three queries in one snapshot, 31 KB of JSON).
- Every plan is index-only (`Heap Fetches: 0`); the page then reads its 51 rows by primary key.
- "After a PostgreSQL restart" empties PostgreSQL's own cache. The operating system's file cache
  inside the Docker VM could not be dropped, so this is not a read from a cold disk; the restart
  column and the HTTP row were taken before the contract step, on the same plans for the page.

### Scenario 3: history of a case with 400 events (target < 200 ms)

| Query | Time | Plan |
| --- | --- | --- |
| Events of `PERF-HISTORY-400`, among 27.9M events | 0.06–0.10 ms | Index scan on `case_events_pkey (case_id, seq)`, 17 buffers |
| `GET /cases/:id/history` end to end (115 KB of JSON) | 4–6 ms | |

The same 0.06 ms as among 2.8M events: the primary key `(case_id, seq)` is the history index
(D-26), and finding a case's events does not depend on how many other events exist.

## 1M against 10M

| Query (repeated on one connection) | 1M | 10M |
| --- | --- | --- |
| Report, first page | 1.1 ms | 5.3–6.5 ms |
| Report, summary (both parts) | 1.2 ms | 7.0–7.9 ms |
| History, 400 events | 0.06 ms | 0.06 ms |

The prediction written before the 10M run (TRADEOFFS §10) was that the report depends on the size of
the tenant's queue, not on the table's row count. It held: Acme's queue is ten times larger and the
report reads and sorts ten times more index entries (89 162 against about 8 800), in a few
milliseconds more. What the 10M run showed that the argument did not:

- **PostgreSQL parallelises the report at this size** (two workers on the page and on the summary).
  With parallelism switched off for the comparison the page took 7.6–9.0 ms and the summary
  13–17 ms, so the default is left alone.
- **The page reads more index entries than it returns candidates for.** `cases_queue_idx` covers
  `OPEN` and `UNDER_REVIEW` together so that it also serves the summary; the default page wants
  only `OPEN`, and discards 50 781 `UNDER_REVIEW` entries out of 81 507 read
  (`Rows Removed by Filter`). An `OPEN`-only index would avoid that at the price of one more index
  on every write to `cases`. At 6 ms against a 100 ms target it is not worth it.

## The contract step: dropping the phase 1 indexes

Phase 4 added `cases_queue_idx` and `cases_queue_breached_idx` next to the phase 1 indexes they
replace (expand). The new ones hold the same columns plus `id`, so the old pair was a duplicate;
the summary still read the old ones only because they are slightly smaller. Before dropping them,
the summary was measured without them, inside a transaction that was rolled back
(`BEGIN; DROP INDEX …; EXPLAIN …; ROLLBACK`), five runs each on 10M:

| Summary | With the phase 1 indexes | Without |
| --- | --- | --- |
| At risk and responded | 6.3–10.3 ms on `cases_at_risk_idx` (1 458 buffers) | 6.4–7.2 ms on `cases_queue_idx` (1 873 buffers) |
| Breached | 0.58–0.76 ms on `cases_breached_idx` (106 buffers) | 0.62–0.69 ms on `cases_queue_breached_idx` (122 buffers) |

Same time, so they were dropped (`DROP INDEX CONCURRENTLY`, one migration each, 0.5 s for both on
the 10M table, no lock on reads or writes). That frees 102 MB and leaves two indexes fewer to
maintain on every write to `cases`. The write-side gain itself was not measured.

## Sizes, and partitioning (D-13)

| Object | Size at 10M |
| --- | --- |
| `case_events` table / with indexes | 5.9 GB / 7.3 GB |
| `cases` table / with indexes | 2.0 GB / 3.3 GB |
| `case_events_pkey` | 1.4 GB |
| `cases_tenant_external_ref_key` | 812 MB |
| `cases_pkey` | 384 MB |
| `cases_queue_breached_idx` | 98 MB |
| `cases_queue_idx` | 34 MB |
| `cases_sweep_idx` | 1.9 MB |

**No partitioning, confirmed.** No measured query depends on the size of a table: history goes
through the primary key, and the report and the sweeper through partial indexes that hold only the
work queue (34 MB, 98 MB and 2 MB over a 2 GB table). Partitioning would not make any of them
faster.

What does grow without limit is `case_events`: about 0.73 GB per million cases, and it is
append-only. That is a retention question, not a performance one, and it is left open on purpose
(D-49, TRADEOFFS §13): nothing is done about it now.

## Results at 1M (phase 4)

Kept because the report index was chosen on these numbers. For Acme: 3 008 cases at risk, 766
breached in the last 7 days, 5 037 responded.

| Query | Time (database) | Plan |
| --- | --- | --- |
| First page, 50 items | 1.1 ms warm; 3.5–13.7 ms cold | Index-only scans of `cases_queue_idx` and `cases_queue_breached_idx`, `Heap Fetches: 0`, top-N sort, then 51 primary-key lookups |
| Next page (cursor) | 0.9 ms | Same plan, starting after the cursor |
| Summary, all three states | 1.2 ms | Index-only scans |
| `GET /reports/stuck-queue` end to end (HTTP, JSON) | 56 ms, first call | |
| Events of `PERF-HISTORY-400`, among 2.8M events | 0.06 ms | Index scan on `case_events_pkey (case_id, seq)` |
| `GET /cases/:id/history` end to end | 14 ms | |

Before the phase 4 index, the first page took **32 ms**: the phase 1 index did not cover `id`, so
PostgreSQL read one table block per case at risk (3 478 blocks). An alternative index ordered by
amount took 23 ms, because walking by amount discards thousands of old deadline losses to find last
week's (NOTES 2.24).

## Raw output at 10M

`npm run perf:explain`, unedited, after the contract step (a first run on a new connection). It was
taken a day after the tables above, so the risk window had moved and the counts differ slightly
(35 077 at risk, 6 589 breached, 53 360 responded).

```text
10000001 cases; explaining for Acme (11111111-1111-4111-8111-111111111111)

=== stuck queue: first page (scenario 4)
Nested Loop  (cost=23879.38..24315.98 rows=51 width=179) (actual time=9.194..11.344 rows=51 loops=1)
  Buffers: shared hit=1998
  ->  Limit  (cost=23878.95..23884.90 rows=51 width=24) (actual time=9.172..11.151 rows=51 loops=1)
        Buffers: shared hit=1794
        ->  Gather Merge  (cost=23878.95..43499.45 rows=168164 width=24) (actual time=9.171..11.148 rows=51 loops=1)
              Workers Planned: 2
              Workers Launched: 2
              Buffers: shared hit=1794
              ->  Sort  (cost=22878.93..23089.13 rows=84082 width=24) (actual time=3.002..3.003 rows=17 loops=3)
                    Sort Key: cases_1.amount_base_minor DESC, cases_1.id DESC
                    Sort Method: top-N heapsort  Memory: 31kB
                    Buffers: shared hit=1794
                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                    Worker 1:  Sort Method: quicksort  Memory: 25kB
                    ->  Parallel Append  (cost=0.42..20073.77 rows=84082 width=24) (actual time=0.536..2.321 rows=13889 loops=3)
                          Buffers: shared hit=1764
                          ->  Parallel Index Only Scan using cases_queue_breached_idx on cases cases_1  (cost=0.43..1290.63 rows=11006 width=24) (actual time=0.010..0.374 rows=6589 loops=1)
                                Index Cond: ((tenant_id = '11111111-1111-4111-8111-111111111111'::uuid) AND (deadline_at >= '2026-09-27 18:45:48.983+00'::timestamp with time zone))
                                Heap Fetches: 0
                                Buffers: shared hit=105
                          ->  Parallel Index Only Scan using cases_queue_idx on cases cases_2  (cost=0.42..18362.74 rows=73076 width=24) (actual time=1.605..5.035 rows=35077 loops=1)
                                Index Cond: ((tenant_id = '11111111-1111-4111-8111-111111111111'::uuid) AND (deadline_at <= '2026-10-11 18:45:48.983+00'::timestamp with time zone))
                                Filter: (status = 'OPEN'::text)
                                Rows Removed by Filter: 53360
                                Heap Fetches: 0
                                Buffers: shared hit=1659
  ->  Index Scan using cases_pkey on cases  (cost=0.43..8.45 rows=1 width=155) (actual time=0.003..0.003 rows=1 loops=51)
        Index Cond: (id = cases_1.id)
        Buffers: shared hit=204
Planning Time: 0.129 ms
Execution Time: 11.382 ms

=== stuck queue: summary
Finalize Aggregate  (cost=24440.73..24440.74 rows=1 width=120) (actual time=10.558..12.687 rows=1 loops=1)
  Buffers: shared hit=1721 read=1
  ->  Gather  (cost=24440.47..24440.68 rows=2 width=120) (actual time=10.511..12.681 rows=3 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=1721 read=1
        ->  Partial Aggregate  (cost=23440.47..23440.48 rows=1 width=120) (actual time=4.433..4.434 rows=1 loops=3)
              Buffers: shared hit=1721 read=1
              ->  Parallel Index Only Scan using cases_queue_idx on cases  (cost=0.42..18024.22 rows=135406 width=20) (actual time=0.018..1.645 rows=29479 loops=3)
                    Index Cond: ((tenant_id = '11111111-1111-4111-8111-111111111111'::uuid) AND (deadline_at <= '2026-10-11 18:45:48.983+00'::timestamp with time zone))
                    Heap Fetches: 0
                    Buffers: shared hit=1721 read=1
Planning Time: 0.099 ms
Execution Time: 12.716 ms

=== stuck queue: summary
Aggregate  (cost=1576.78..1576.79 rows=1 width=40) (actual time=0.506..0.506 rows=1 loops=1)
  Buffers: shared hit=105
  ->  Index Only Scan using cases_queue_breached_idx on cases  (cost=0.43..1444.71 rows=26414 width=8) (actual time=0.011..0.320 rows=6589 loops=1)
        Index Cond: ((tenant_id = '11111111-1111-4111-8111-111111111111'::uuid) AND (deadline_at >= '2026-09-27 18:45:48.983+00'::timestamp with time zone))
        Heap Fetches: 0
        Buffers: shared hit=105
Planning Time: 0.056 ms
Execution Time: 0.512 ms

=== stuck queue: second page (keyset)
Nested Loop  (cost=24964.08..25400.68 rows=51 width=179) (actual time=9.526..11.642 rows=51 loops=1)
  Buffers: shared hit=2003 read=1
  ->  Limit  (cost=24963.65..24969.60 rows=51 width=24) (actual time=9.497..11.431 rows=51 loops=1)
        Buffers: shared hit=1799 read=1
        ->  Gather Merge  (cost=24963.65..44502.71 rows=167466 width=24) (actual time=9.496..11.428 rows=51 loops=1)
              Workers Planned: 2
              Workers Launched: 2
              Buffers: shared hit=1799 read=1
              ->  Sort  (cost=23963.62..24172.96 rows=83733 width=24) (actual time=3.439..3.442 rows=51 loops=3)
                    Sort Key: cases_1.amount_base_minor DESC, cases_1.id DESC
                    Sort Method: top-N heapsort  Memory: 31kB
                    Buffers: shared hit=1799 read=1
                    Worker 0:  Sort Method: top-N heapsort  Memory: 31kB
                    Worker 1:  Sort Method: top-N heapsort  Memory: 30kB
                    ->  Parallel Append  (cost=0.42..21170.11 rows=83733 width=24) (actual time=0.534..2.771 rows=13872 loops=3)
                          Buffers: shared hit=1769 read=1
                          ->  Parallel Index Only Scan using cases_queue_breached_idx on cases cases_1  (cost=0.43..1373.17 rows=10960 width=24) (actual time=0.025..0.561 rows=2192 loops=3)
                                Index Cond: ((tenant_id = '11111111-1111-4111-8111-111111111111'::uuid) AND (deadline_at >= '2026-09-27 18:45:49.061+00'::timestamp with time zone))
                                Filter: ((amount_base_minor < '2117250'::bigint) OR ((amount_base_minor = '2117250'::bigint) AND (id < '02031212-f35f-4ca6-b8f2-e86f0a241c48'::uuid)))
                                Rows Removed by Filter: 4
                                Heap Fetches: 0
                                Buffers: shared hit=110 read=1
                          ->  Parallel Index Only Scan using cases_queue_idx on cases cases_2  (cost=0.42..19378.28 rows=72773 width=24) (actual time=1.529..5.063 rows=35039 loops=1)
                                Index Cond: ((tenant_id = '11111111-1111-4111-8111-111111111111'::uuid) AND (deadline_at <= '2026-10-11 18:45:49.061+00'::timestamp with time zone))
                                Filter: ((status = 'OPEN'::text) AND ((amount_base_minor < '2117250'::bigint) OR ((amount_base_minor = '2117250'::bigint) AND (id < '02031212-f35f-4ca6-b8f2-e86f0a241c48'::uuid))))
                                Rows Removed by Filter: 53398
                                Heap Fetches: 0
                                Buffers: shared hit=1659
  ->  Index Scan using cases_pkey on cases  (cost=0.43..8.45 rows=1 width=155) (actual time=0.004..0.004 rows=1 loops=51)
        Index Cond: (id = cases_1.id)
        Buffers: shared hit=204
Planning:
  Buffers: shared hit=8
Planning Time: 0.165 ms
Execution Time: 11.689 ms

=== case history, 400 events (scenario 3)
Index Scan using case_events_pkey on case_events  (cost=0.56..201.42 rows=49 width=208) (actual time=0.009..0.049 rows=400 loops=1)
  Index Cond: (case_id = 'b716117c-0415-46e6-b2f6-86697bda00c7'::uuid)
  Buffers: shared hit=17
Planning Time: 0.018 ms
Execution Time: 0.060 ms
```
