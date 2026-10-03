# Migrations

Hand-written PostgreSQL, applied in filename order by `npm run db:migrate`
(`src/infrastructure/db/migrator.ts`, CLI in `scripts/migrate.ts`). Status with
`npm run db:migrate:status`.

```
NNNN_snake_case_description.sql
```

The rollout plan for live data is in [`../docs/MIGRATION_PLAN.md`](../docs/MIGRATION_PLAN.md).

## Rules

1. **Plain SQL, never generated.** A regulator has to be able to read what runs against production.
2. **Safe while the previous app version serves traffic.** Expand, migrate, contract as separate
   releases.
3. **Never `ALTER COLUMN TYPE`.** Add a column, backfill in batches, switch reads, drop later.
4. **Never `SET NOT NULL` in one step.** `CHECK … NOT VALID`, `VALIDATE CONSTRAINT`, then `SET NOT NULL`.
5. **Indexes on existing tables are built `CONCURRENTLY`.**
6. **Never edit an applied migration.** The runner compares SHA-256 checksums and refuses to run.
   Fix forward in a new file.
7. **Forward only.** There is no `down` command. Every file states its rollback, or that it is
   irreversible and why, in its header comment.
8. **Name constraints explicitly** (`<table>_<column>_check`), so a future migration can drop or
   replace them by name.
9. **No `IF NOT EXISTS` on tables, columns or indexes.** The runner already guarantees each
   migration runs exactly once and atomically (ledger, checksum, one transaction per file), so it
   protects nothing. Worse, it only compares names: `CREATE TABLE IF NOT EXISTS cases` would skip a
   `cases` table with a different shape, record the migration as applied, and let the ledger lie.
   On a concurrent index it would keep an `INVALID` index forever. An "already exists" error is the
   correct, loud outcome. The exceptions are objects outside the ledger's control: roles (cluster
   wide, often provisioned by infrastructure, see `0001`) and extensions.

## What the runner does

- Takes a PostgreSQL advisory lock, so two deploys cannot run migrations at the same time.
- **Only starts from an empty database.** If the database has tables but no `triple_migrations`
  ledger (another tool's schema, a legacy system), it refuses before touching anything. Adopting an
  existing schema needs a dedicated baseline migration, written on purpose.
- Records each migration in `triple_migrations` with its checksum, mode and duration. The name is
  project-specific so it never adopts another tool's `schema_migrations`.
- Transactional migrations run with `lock_timeout = 5s`: one that cannot get its lock fails instead
  of queueing in front of live traffic. Files do not need to set it.
- Runs each migration in its own transaction, **unless** the file starts with:

  ```sql
  -- migrate:no-transaction
  ```

  `CREATE INDEX CONCURRENTLY` cannot run inside a transaction (D-14). Such a file must contain exactly
  one statement, because several statements sent together run as an implicit transaction.

  These run with `lock_timeout = 0` and `statement_timeout = 0`. A concurrent build must wait for
  every transaction already open on the table; a timeout would cancel it halfway. Its lock does not
  block reads or writes, so waiting is safe; it is slow, not disruptive.

  If the build fails anyway (duplicate data for a unique index, a cancelled session), the runner
  drops the `INVALID` index **that this migration left**, so a retry starts clean. Invalid indexes
  that existed before are left alone: they are not ours.

## Known limits

- **`0001` needs `CREATEROLE` only if `triple_app` does not exist yet.** On a managed database the
  role is normally provisioned by infrastructure beforehand, and the migration then only grants
  `USAGE` to it.
- **`case_events` rejects `UPDATE` for every role, including migrations.** A future backfill of a new
  column on that table has to disable the trigger inside its own migration, which is visible in
  review. Prefer adding nullable columns that only new events fill.

## Lint

`npm run lint:sql` runs sqlfluff 4.4.0 in Docker. sqlfluff owns SQL layout and semantics; Prettier
does not touch `.sql` files.

## Current migrations

| File | Contents | Mode |
| --- | --- | --- |
| `0001_app_role.sql` | `triple_app` role, no `DELETE` anywhere | transactional |
| `0002_tenants.sql` | Banks | transactional |
| `0003_response_windows.sql` | Windows per scheme and reason code, brief defaults seeded | transactional |
| `0004_fx_rates.sql` | Fixed rates for base-currency ordering | transactional |
| `0005_cases.sql` | The projection; column-level `UPDATE` grant | transactional |
| `0006_case_events.sql` | The log; append-only trigger, DB clock, `ON DELETE RESTRICT` | transactional |
| `0007_tenant_rule_config.sql` | Rule order and enablement per tenant | transactional |
| `0008_cases_at_risk_index.sql` | Report index, at-risk part | no transaction |
| `0009_cases_breached_index.sql` | Report index, breached part | no transaction |
| `0010_cases_sweep_index.sql` | Sweeper index | no transaction |
