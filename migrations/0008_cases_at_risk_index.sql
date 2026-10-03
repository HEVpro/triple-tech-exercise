-- migrate:no-transaction
-- Stuck-queue report, at-risk part: per tenant, open work whose deadline falls inside the
-- risk window. INCLUDE lets the report read amount and status from the index alone.
-- CONCURRENTLY does not block writes on a live table, and cannot run in a transaction.
-- Rollback: DROP INDEX CONCURRENTLY cases_at_risk_idx.

CREATE INDEX CONCURRENTLY cases_at_risk_idx
ON cases (tenant_id, deadline_at) INCLUDE (amount_base_minor, status)
WHERE status IN ('OPEN', 'UNDER_REVIEW');
