-- Per-tenant enablement and order of the terminal rules. The predicates live in code
-- (src/domain); only the order and the on/off switch are data. No row for a tenant means
-- the default rule set. Changed by migration only: there is no admin API.
-- Rollback: DROP TABLE tenant_rule_config.

CREATE TABLE tenant_rule_config (
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  rule_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, rule_key),
  CONSTRAINT tenant_rule_config_rule_key_check CHECK (
    rule_key IN ('deadline_passed', 'evidence_filed', 'scheme_outcome')
  ),
  CONSTRAINT tenant_rule_config_priority_key UNIQUE (tenant_id, priority)
);

GRANT SELECT ON tenant_rule_config TO triple_app;
