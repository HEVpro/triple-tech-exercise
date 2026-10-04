-- migrate:no-transaction
-- Contract step for 20261003031106: cases_queue_idx holds everything cases_at_risk_idx does plus
-- `id`, so the old index only duplicated it. Only the report's summary still read it, because it
-- is slightly smaller; without it the summary reads cases_queue_idx in the same time (6-7 ms on
-- the 10M fixture, docs/PERFORMANCE.md), and every write to `cases` maintains one index less.
--
-- CONCURRENTLY does not block reads or writes on `cases`; it waits for running transactions.
-- Rollback: recreate it as in 0008_cases_at_risk_index.sql (CREATE INDEX CONCURRENTLY).
DROP INDEX CONCURRENTLY cases_at_risk_idx;
