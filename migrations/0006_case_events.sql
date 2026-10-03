-- The source of truth. Append-only, enforced three ways:
--   1. triple_app has SELECT and INSERT only.
--   2. A trigger rejects UPDATE, DELETE and TRUNCATE for every role, including the owner.
--   3. The foreign key to cases is ON DELETE RESTRICT, so a case with events cannot be
--      deleted and take its audit trail with it.
--
-- Clocks: recorded_at is always the database clock, set by the trigger, whatever the
-- client sends. occurred_at is the business time of the fact and equals recorded_at for
-- every event except DEADLINE_EXPIRED, whose occurred_at is the deadline itself.
--
-- Rollback: irreversible by design once a row exists.

CREATE TABLE case_events (
  case_id UUID NOT NULL REFERENCES cases (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  rule_key TEXT,
  ruleset_version INTEGER,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, seq),
  CONSTRAINT case_events_seq_check CHECK (seq >= 1),
  CONSTRAINT case_events_event_type_check CHECK (
    event_type IN (
      'CASE_CREATED',
      'EVIDENCE_FILED',
      'SCHEME_OUTCOME_RECORDED',
      'DEADLINE_EXPIRED',
      'NOTE_ADDED'
    )
  ),
  CONSTRAINT case_events_actor_type_check CHECK (actor_type IN ('human', 'agent', 'system')),
  CONSTRAINT case_events_actor_id_check CHECK (length(actor_id) BETWEEN 1 AND 200),
  CONSTRAINT case_events_from_status_check CHECK (
    from_status IN ('OPEN', 'UNDER_REVIEW', 'WON', 'LOST')
  ),
  CONSTRAINT case_events_to_status_check CHECK (
    to_status IN ('OPEN', 'UNDER_REVIEW', 'WON', 'LOST')
  ),
  CONSTRAINT case_events_rule_key_check CHECK (
    rule_key IN ('deadline_passed', 'evidence_filed', 'scheme_outcome', 'default_open')
  ),
  CONSTRAINT case_events_reason_check CHECK (length(reason) <= 1000),
  CONSTRAINT case_events_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384
  ),
  -- Only the creation event has no previous status.
  CONSTRAINT case_events_created_from_check CHECK (
    (event_type = 'CASE_CREATED') = (from_status IS NULL)
  ),
  -- Every event that decides a status says which rule decided it; a note decides nothing.
  CONSTRAINT case_events_rule_presence_check CHECK (
    (event_type = 'NOTE_ADDED') = (rule_key IS NULL AND ruleset_version IS NULL)
  ),
  -- The deadline expiry is the only automated event, and only the system performs it.
  CONSTRAINT case_events_system_actor_check CHECK (
    (actor_type = 'system') = (event_type = 'DEADLINE_EXPIRED')
  ),
  -- Clients cannot backdate: only the deadline expiry carries its own business time.
  CONSTRAINT case_events_occurred_at_check CHECK (
    occurred_at = recorded_at
    OR (event_type = 'DEADLINE_EXPIRED' AND occurred_at <= recorded_at)
  )
);

CREATE FUNCTION case_events_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    NEW.recorded_at := now();
    NEW.occurred_at := coalesce(NEW.occurred_at, NEW.recorded_at);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'case_events is append-only: % is not allowed', tg_op
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER case_events_stamp_and_guard
BEFORE INSERT OR UPDATE OR DELETE ON case_events
FOR EACH ROW EXECUTE FUNCTION case_events_guard();

CREATE TRIGGER case_events_no_truncate
BEFORE TRUNCATE ON case_events
FOR EACH STATEMENT EXECUTE FUNCTION case_events_guard();

GRANT SELECT, INSERT ON case_events TO triple_app;
