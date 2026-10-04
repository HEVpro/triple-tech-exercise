-- migrate:no-transaction
-- Contract step for 20261003031107: cases_queue_breached_idx holds everything cases_breached_idx
-- does plus `id`. Only the report's summary still read the old index; without it the summary
-- reads the new one in the same time (0.6 ms on the 10M fixture, docs/PERFORMANCE.md).
--
-- CONCURRENTLY does not block reads or writes on `cases`; it waits for running transactions.
-- Rollback: recreate it as in 0009_cases_breached_index.sql (CREATE INDEX CONCURRENTLY).
DROP INDEX CONCURRENTLY cases_breached_idx;
