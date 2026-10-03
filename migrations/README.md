# Migrations

One file per migration, applied in lexicographic order. Filenames are zero padded so ordering is
obvious to a reviewer reading `git log` on this directory.

```
NNNN_snake_case_description.sql
```

## Rules

1. **Plain `.sql`, never generated DSL.** A regulator has to be able to read what runs against
   production without trusting our application code.
2. **Every migration must be safe while the previous version of the app is still serving traffic.**
   That means expand / migrate / contract as three separate deploys, never one. See
   `docs/MIGRATION_PLAN.md`.
3. **Never `ALTER COLUMN TYPE`.** Add a column, backfill in batches, swap reads, drop the old one in
   a later migration.
4. **Never `SET NOT NULL` in one step.** Add `CHECK (...) NOT VALID`, `VALIDATE CONSTRAINT`, then
   `SET NOT NULL`.
5. **No table or column rewrite that takes an `ACCESS EXCLUSIVE` lock for longer than a few
   milliseconds on a large table.**

## Transaction control

`CREATE INDEX CONCURRENTLY` and `CONCURRENTLY` index drops **cannot run inside a transaction**. The
migration runner therefore has to support per-migration transaction control. That is decision
**D-14** and it is a property of the runner, not of an individual migration file: the convention below
lets a migration opt out of the transaction without changing the runner later.

A migration opts out by starting with this marker:

```sql
-- migrate:no-transaction
```

Until phase 1 lands the runner, do not rely on this. When the runner arrives, the convention above
is what it will read, and every concurrent index migration must use it.

## Idempotency

Migrations are not wrapped in retry logic and are not expected to be re-runnable. The runner records
what has been applied; if a migration fails, fix it forward in a new file rather than editing an
applied one. The only exception is `CREATE INDEX IF NOT EXISTS` and friends, used deliberately where
a retry is safe.