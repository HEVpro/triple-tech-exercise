-- The read projection of a case. case_events is the source of truth (0006); this table
-- exists so GET /cases/:id and the stuck-queue report stay fast.
--
-- amount_minor: integer minor units scaled by the ISO 4217 exponent of currency. The API
-- also exposes it as amount_cents, the field name in the brief, for compatibility.
-- version: per-case event counter. Each event takes seq = the new version, so events are
-- numbered 1..n without gaps, and a gap would reveal a deleted event.
-- decided_by_rule: the terminal rule that produced the current status.
-- Rollback: DROP TABLE cases (only before any event exists; afterwards it is irreversible
-- by design).

CREATE TABLE cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  external_ref TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  amount_base_minor BIGINT NOT NULL,
  base_currency CHAR(3) NOT NULL,
  fx_rate NUMERIC(20, 10) NOT NULL,
  fx_rate_date DATE NOT NULL,
  scheme TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  presentment_date DATE NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  deadline_window_id BIGINT NOT NULL REFERENCES response_windows (id),
  deadline_window_days INTEGER NOT NULL,
  deadline_tz TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by_rule TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cases_tenant_external_ref_key UNIQUE (tenant_id, external_ref),
  CONSTRAINT cases_external_ref_check CHECK (length(external_ref) BETWEEN 1 AND 128),
  CONSTRAINT cases_amount_minor_check CHECK (amount_minor > 0),
  CONSTRAINT cases_amount_base_minor_check CHECK (amount_base_minor >= 0),
  CONSTRAINT cases_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT cases_base_currency_check CHECK (base_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT cases_fx_rate_check CHECK (fx_rate > 0),
  CONSTRAINT cases_scheme_check CHECK (scheme IN ('VISA', 'MASTERCARD', 'OTHER')),
  CONSTRAINT cases_reason_code_check CHECK (length(reason_code) BETWEEN 1 AND 20),
  CONSTRAINT cases_status_check CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'WON', 'LOST')),
  CONSTRAINT cases_decided_by_rule_check CHECK (
    decided_by_rule IN ('deadline_passed', 'evidence_filed', 'scheme_outcome', 'default_open')
  ),
  CONSTRAINT cases_version_check CHECK (version >= 1),
  CONSTRAINT cases_deadline_window_days_check CHECK (deadline_window_days BETWEEN 1 AND 365)
);

-- The application may only move the projection forward. Every other column is fixed at
-- creation, so a column-level grant makes that a database property, not a convention.
GRANT SELECT, INSERT ON cases TO triple_app;
GRANT UPDATE (status, decided_by_rule, version, updated_at) ON cases TO triple_app;
