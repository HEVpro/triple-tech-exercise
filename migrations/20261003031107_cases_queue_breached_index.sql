-- migrate:no-transaction
-- Stuck-queue report, breached part: cases lost to the deadline rule, by deadline, covering
-- (amount, id) so the page is index-only. Replaces cases_breached_idx, which lacked `id`.
-- Expand step; the old index is dropped by a later migration.
-- Rollback: DROP INDEX CONCURRENTLY cases_queue_breached_idx.
CREATE INDEX CONCURRENTLY cases_queue_breached_idx
ON cases (tenant_id, deadline_at) INCLUDE (amount_base_minor, id)
WHERE status = 'LOST' AND decided_by_rule = 'deadline_passed';
