# Migration plan against live data

The brief asks for *"migration(s) you would run against live data for 60+ tenants"*. This is that
plan. The migrations themselves are in [`../migrations`](../migrations); their conventions are in
[`../migrations/README.md`](../migrations/README.md).

---

## The assumption

One shared PostgreSQL database, every business table carrying `tenant_id` (D-1). Schema changes run
once; data steps, when there are any, run per tenant. If the platform were one database per tenant,
the same files would run 60 times with the wave order below.

The schema is greenfield: there is no legacy database to import. What has to be true is that
**every migration in this repository can be applied while the API is serving traffic**, and so can
every future one.

---

## Why a migration can hurt a live database

Three PostgreSQL facts drive every rule below.

1. **The lock queue.** `ALTER TABLE` needs an `ACCESS EXCLUSIVE` lock. It is usually held for
   milliseconds, but if it has to *wait* behind a long query it joins a queue, and every query that
   arrives after it waits too. A one-millisecond change can stall the API for as long as the slowest
   running query.
2. **Some operations rewrite or scan the whole table.** Changing a column type rewrites it.
   `SET NOT NULL` scans it under the exclusive lock. A plain `CREATE INDEX` blocks writes for the
   whole build.
3. **A large `UPDATE` is one long transaction.** It holds row locks, bloats the table and delays
   vacuum.

## The rules that follow

| Rule | How it is enforced |
| --- | --- |
| Never wait for a lock for long | The runner sets `lock_timeout = 5s` on every migration. It fails and is retried, instead of queueing. |
| Indexes are built `CONCURRENTLY` | Files marked `-- migrate:no-transaction`, one statement each; the runner checks no invalid index is left behind. |
| New columns are nullable, or have a constant default | Instant in PostgreSQL 11+. |
| `NOT NULL` in two steps | `ADD CONSTRAINT … CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT` (no exclusive lock), then `SET NOT NULL`. |
| Never `ALTER COLUMN TYPE` | Add a column, backfill in batches, switch reads, drop later. |
| Backfills in batches | ~5 000 rows per transaction, keyed by primary key, idempotent (`WHERE new_col IS NULL`), resumable. |
| Applied migrations are immutable | The runner stores a SHA-256 per file and refuses to run if one changed. Fix forward. |
| One runner at a time | A PostgreSQL advisory lock around the whole run. |

---

## Expand, migrate, contract

Any change that existing code would notice is split across releases, so the previous version of the
application keeps working at every step and rollback is always "deploy the previous version".

| Step | What happens | Old app | Rollback |
| --- | --- | --- | --- |
| **Expand** | Add tables, nullable columns, indexes `CONCURRENTLY` | Ignores them | Nothing to undo |
| **Migrate** | New app writes both shapes; backfill old rows per tenant | Unaffected | Redeploy old app |
| **Contract** | Validate constraints, switch reads, eventually drop the old shape | Already retired | **The only irreversible step** |

Worked example, a future change: making a new `cases.priority` column mandatory.

1. Expand: `ALTER TABLE cases ADD COLUMN priority TEXT` (instant).
2. Release N writes `priority` on every new or updated case.
3. Backfill existing cases tenant by tenant, in batches.
4. Contract: `CHECK (priority IS NOT NULL) NOT VALID`, `VALIDATE`, `SET NOT NULL`, each its own
   migration.

The contract step for a public field never removes it while a bank reads it: `amount_cents` stays in
the API indefinitely.

---

## Rolling out across 60+ tenants

Schema migrations run once. Data steps and behaviour switches go tenant by tenant, so a problem
affects one bank, not all of them.

1. **Canary:** one or two small tenants. Verify, then wait one business day.
2. **Wave 1:** about 10% of tenants, mixed sizes.
3. **Wave 2:** the rest, largest last, outside their business hours.

Each tenant's progress would be recorded in a `migration_runs` table (tenant, step, status, rows,
timestamps) so a failed tenant is retried on its own.

**Verification after each tenant**, all as SQL that returns zero rows when healthy:

- no case without its creation event;
- `cases.status` equals the last event's `to_status`, and `cases.version` equals the highest `seq`
  (invariant 3);
- no `NULL` in a column about to become mandatory;
- `SELECT … FROM pg_index WHERE NOT indisvalid` is empty.

---

## Downtime and duration

- **Planned downtime: none.** Locks are milliseconds, bounded by `lock_timeout`.
- **This repository's migrations** on an empty database apply in well under a second (CI applies
  them on every run, twice, to prove idempotency).
- **A batched backfill** of a 10M-row tenant is an estimate of 10 to 20 minutes, throttled; it will be
  measured against the performance fixture rather than claimed.

---

## Future: importing an existing database

Not built, recorded so the trap is known. If cases ever had to be imported from a system without an
event log:

- each imported case gets one `CASE_IMPORTED` event, and history before it reports
  `history_available_from` instead of inventing a past;
- the amount must be audited per tenant and currency before copying: a legacy `amount_cents` may
  already hold JPY in yen;
- **the deadline sweeper stays off for that tenant until a dry-run list of already-expired cases has
  been reviewed with the bank**, otherwise the first sweep marks hundreds of cases `LOST` at once.
