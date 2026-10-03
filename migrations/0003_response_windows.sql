-- How long a bank has to answer a dispute, per scheme and reason code.
-- reason_code NULL is the scheme default; a specific reason code overrides it.
-- A row is changed only by a migration, so git history is the audit trail of this table.
-- Cases snapshot window_days and deadline_tz at creation, so changing a row never moves
-- the deadline of an existing case.
-- Rollback: DROP TABLE response_windows (only before any case exists).

CREATE TABLE response_windows (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scheme TEXT NOT NULL,
  reason_code TEXT,
  window_days INTEGER NOT NULL,
  deadline_tz TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT response_windows_scheme_check CHECK (scheme IN ('VISA', 'MASTERCARD', 'OTHER')),
  CONSTRAINT response_windows_reason_code_check CHECK (length(reason_code) BETWEEN 1 AND 20),
  CONSTRAINT response_windows_window_days_check CHECK (window_days BETWEEN 1 AND 365),
  CONSTRAINT response_windows_scheme_reason_code_key UNIQUE NULLS NOT DISTINCT (
    scheme, reason_code
  )
);

INSERT INTO response_windows (scheme, reason_code, window_days) VALUES
('VISA', NULL, 45),
('MASTERCARD', NULL, 45),
('OTHER', NULL, 30);

GRANT SELECT ON response_windows TO triple_app;
