-- Operator-reviewed Supabase database protection, independent of Auth/Storage.
-- Apply to the authorized NewsCraft project as the migration/table owner.
-- For initial setup, use newscraft-new-project-schema.sql: it includes these
-- protections in the SAME transaction as table creation, before any commit.
-- This standalone file is for explicit reapplication after reviewed migrations.
-- It does not create buckets, accounts, keys, policies or external permissions.
BEGIN;
DO $requirements$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Expected Supabase browser roles are absent';
  END IF;
  IF to_regclass('public.newscraft_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Apply the reviewed NewsCraft schema first';
  END IF;
END
$requirements$;

-- These defaults apply to future objects created by this migration role.
-- Future migrations must still explicitly enable RLS on their own tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

DO $security$
DECLARE table_name text;
BEGIN
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', table_name);
  END LOOP;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

  -- The app server owns authentication and checks tenant/account ownership.
  -- Direct browser table access has no role in either supported auth adapter.
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND (
      NOT rowsecurity OR
      has_table_privilege('anon', format('%I.%I', schemaname, tablename),
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege('authenticated', format('%I.%I', schemaname, tablename),
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    )
  ) THEN
    RAISE EXCEPTION 'Direct browser table access is not fully disabled';
  END IF;
END
$security$;
COMMIT;
