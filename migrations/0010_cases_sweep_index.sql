-- migrate:no-transaction
-- Deadline sweeper: open cases across all tenants whose deadline has passed.
-- Only OPEN: a case UNDER_REVIEW filed evidence in time and cannot lose to the deadline.
-- Rollback: DROP INDEX CONCURRENTLY cases_sweep_idx.

CREATE INDEX CONCURRENTLY cases_sweep_idx
ON cases (deadline_at)
WHERE status = 'OPEN';
