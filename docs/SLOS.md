# SLOs and on-call alerts

The brief's bonus question: *what should page someone at 3am: a breached deadline, evidence filed
late, a failed history write?* In other words: which alerts need the person on call, at any hour.
This document answers it, says what the service promises, and shows how each promise is watched.

The provider is **Sentry**, the tool the team already uses. It is named in one folder,
`src/monitoring` (ESLint forbids importing it anywhere else); the rest of the code calls that
folder's functions, so changing provider means rewriting it and nothing else.

## The rule for a page

The person on call is paged only for what **they can fix** and what **gets worse by waiting until
working hours**. Everything else is a ticket or a number on a dashboard.

## The brief's three candidates

| Candidate | Page? | Why |
| --- | --- | --- |
| A breached deadline | **No** | The system worked: the bank did not answer in time. Nobody can recover a deadline that has passed. It is a business outcome, and the stuck-queue report exists to show it as `at_risk` days before it happens. |
| Evidence filed late | **No** | The API rejects it with a `409`, which is the correct answer. Also a business outcome. |
| A failed history write | **Yes** | The only one of the three that is our failure. |

A history write cannot half-fail: the event and the case row are written in one transaction
(invariant 2), so a failed write is a request answered with a `500` and nothing stored. What is
watched is therefore the rate of `500`s on the write routes.

**What the brief does not list and does page: the sweeper stopping.** It is the only thing the
system does on its own as time passes. If it stops, cases whose deadline has passed stay `OPEN`:
the stored status is false and the report shows lost money as recoverable. It gets worse every
minute, and an engineer can fix it.

## Objectives

| # | Indicator | Objective | When it is missed |
| --- | --- | --- | --- |
| 1 | Writes answered without a `500` (`POST /cases`, `POST /cases/:id/transitions`, `POST /cases/:id/notes`) | 99.9% over 30 days | **Page** |
| 2 | Sweep lag: time between a deadline passing and its `DEADLINE_EXPIRED` event | under 5 minutes | **Page** after 15 minutes |
| 3 | `GET /cases/:id/history` latency | p99 under 200 ms | Ticket |
| 4 | `GET /reports/stuck-queue` latency | p99 under 100 ms | Ticket |

The 200 ms and 100 ms come from the brief's review scenarios; measured today at 4–6 ms and
17–24 ms on ten million cases ([`PERFORMANCE.md`](./PERFORMANCE.md)). **The 99.9% and the 5 and 15
minutes are engineering proposals, not business requirements**: they are a starting point to agree
with the people who own the operation. Latency is a ticket because a slow report loses no money
overnight.

## How each one is watched

Set `SENTRY_DSN` and both processes report; without it nothing is initialised and nothing is sent.

| What | Signal | Where it comes from |
| --- | --- | --- |
| Failed writes (1) | An error event for every request answered with a `500`, and each request's trace with its route and status | `trackErrors` in `src/monitoring/http.ts`, wired in `src/index.ts` |
| Sweeper not running, failing or overrunning (2) | A schedule monitor, `deadline-sweeper`: told when every pass starts and how it ends | `watchSchedule` in `src/monitoring/index.ts`, called by `src/worker/main.ts` |
| Sweeper running but behind (2) | The measure `deadline_sweeper.max_lag_seconds`: how late the most overdue case of the pass was recorded | `recordGauge`, called by `src/worker/main.ts` |
| Latency (3, 4) | Each request's trace: duration per route | `src/instrument.ts`, loaded before the API |

Three details that matter:

- **Business rejections are not reported as failures.** Sentry's Hono integration reports every
  error that does not carry a 3xx/4xx `status`, and `CaseError` (late evidence, a closed case, an
  unknown case) carries none, so by default every `409` and `404` would be an error event and
  objective 1 would page on the bank's own mistakes. `trackErrors` therefore takes the definition
  of a failure as an argument, and the API passes "what it answers with a `500`"; a test runs
  Sentry for real and checks both directions.
- **The sweeper's monitor is defined in code.** The first check-in creates or updates it in Sentry
  with its schedule and thresholds (one pass per `SWEEP_INTERVAL_MS`, an issue after 15 minutes
  without a successful pass), so it cannot drift from the deployment. It works the same for the
  loop (`npm run worker`) and for a scheduled one-pass run (`npm run sweep` from a Lambda or a
  CronJob), which flushes before it exits.
- **Two signals for the sweeper, because each misses what the other sees.** The cron monitor
  catches a sweeper that does not run or fails. The lag metric catches one that runs on time but
  cannot keep up (a pass is capped at 50 000 cases).

## What has to be configured in Sentry

The code sends the signals. Turning them into pages is configuration in Sentry, not in this
repository, and it has not been tried against a real Sentry project: the signals were checked
against a local server standing in for Sentry.

| Monitor | Type | Condition | Action |
| --- | --- | --- | --- |
| Failed writes | Metric monitor on spans | share of `POST /cases*` requests with status `500` above 5% for 5 minutes | Page |
| Failed writes, slow | Metric monitor on spans | above 0.1% over 24 hours | Ticket |
| `deadline-sweeper` | Cron monitor (created by the code) | 15 minutes without a successful check-in | Page |
| Sweep lag | Metric monitor on `deadline_sweeper.max_lag_seconds` | above 900 for 5 minutes | Page |
| History latency | Metric monitor on spans | p99 of `GET /cases/:id/history` above 200 ms for 15 minutes | Ticket |
| Report latency | Metric monitor on spans | p99 of `GET /reports/stuck-queue` above 100 ms for 15 minutes | Ticket |
| API unreachable | Uptime monitor on `GET /readyz` | fails | Page |

The last one covers what the others cannot: an API that is down sends no events at all.

## What is not a page, and where it goes instead

- **Breached deadlines and late evidence** are in the product: `GET /reports/stuck-queue` counts
  `at_risk`, `responded` and `breached` per bank, with amounts.
- **A case that does not match its event log** (invariant 3) would be data corruption and would
  page. It is not watched continuously: the check reads the whole table, so it belongs in a
  periodic audit, which is not built. Run by hand on the ten-million-case database, after a sweep
  that expired 5 461 cases, it took 14 seconds and found no mismatch.

## What this does not cover

- Sentry's alert routing (who is on call, PagerDuty or Slack) is the team's existing setup.
- `SENTRY_TRACES_SAMPLE_RATE` defaults to 1 (every request traced). At real volume it is lowered;
  percentiles stay valid on a sample, error events are not sampled.
- There is no scrape endpoint. The Prometheus `/metrics` endpoint from phase 0 had no consumer and
  was removed (D-51); whether the platform needs one is a question for the company's
  infrastructure.
