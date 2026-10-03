-- migrate:no-transaction
-- Stuck-queue report, breached part: cases lost to the deadline rule within the lookback.
-- Rollback: DROP INDEX CONCURRENTLY cases_breached_idx.

CREATE INDEX CONCURRENTLY cases_breached_idx
ON cases (tenant_id, deadline_at) INCLUDE (amount_base_minor)
WHERE status = 'LOST' AND decided_by_rule = 'deadline_passed';
