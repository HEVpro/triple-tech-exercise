-- The application connects through a login role that is a member of triple_app.
-- triple_app gets no DELETE anywhere and no UPDATE on case_events (see 0006).
-- Roles are cluster-wide, so creation is idempotent.
-- Rollback: DROP ROLE triple_app, only after every grant that references it is gone.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'triple_app') THEN
    CREATE ROLE triple_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO triple_app;
