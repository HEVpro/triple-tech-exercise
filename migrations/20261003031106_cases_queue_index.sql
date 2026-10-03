-- migrate:no-transaction
-- Stuck-queue report: open and responded work per tenant, by deadline. Replaces
-- cases_at_risk_idx, which lacked `id`: the report orders and paginates by (amount, id), so
-- without it PostgreSQL read one table block per case at risk (32 ms for a 800k-case tenant on
-- the 1M fixture). Covering `id` makes both the page and the summary index-only (3.5 ms).
-- Evidence in NOTES 2.24 and docs/PERFORMANCE.md.
--
-- Expand step: the old index stays until the new one is confirmed in use, then a later
-- migration drops it. CONCURRENTLY reads the table and writes only the index; it does not block
-- reads or writes and changes no row.
-- Rollback: DROP INDEX CONCURRENTLY cases_queue_idx.
CREATE INDEX CONCURRENTLY cases_queue_idx
ON cases (tenant_id, deadline_at) INCLUDE (amount_base_minor, status, id)
WHERE status IN ('OPEN', 'UNDER_REVIEW');
