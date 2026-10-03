-- One row per bank. display_timezone is presentation only: deadlines are anchored to
-- the scheme's timezone (response_windows.deadline_tz), never to the tenant's.
-- Rollback: DROP TABLE tenants (only before any case exists).

CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  base_currency CHAR(3) NOT NULL,
  display_timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenants_name_check CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT tenants_base_currency_check CHECK (base_currency ~ '^[A-Z]{3}$')
);

GRANT SELECT ON tenants TO triple_app;
