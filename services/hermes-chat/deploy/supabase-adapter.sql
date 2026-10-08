-- OPTIONAL storage setup for a NEW Supabase project, after the reviewed schema.
-- Not part of the generic Postgres migration runner. No data is imported.
-- Database protection is required even without this optional storage adapter:
-- use newscraft-new-project-schema.sql for initial setup, or separately reviewed
-- supabase-database-private.sql for existing initialized NewsCraft tables.
-- The application server authorizes every row/object request. Internal account
-- IDs intentionally differ from Auth UIDs; no uid=account_id policy is valid.
BEGIN;
DO $security$
DECLARE table_name text;
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Supabase Auth schema is required for this optional adapter';
  END IF;
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', table_name);
  END LOOP;
  -- No direct browser table or object policies are granted. Private download
  -- and non-upserting upload grants come only from authorized application routes.
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('newsroom-documents', 'newsroom-documents', false, 20971520, ARRAY['application/pdf']),
         ('newsroom-artifacts', 'newsroom-artifacts', false, 20971520,
          ARRAY['image/png', 'image/jpeg', 'text/csv', 'text/markdown', 'application/json']);
END
$security$;
COMMIT;
