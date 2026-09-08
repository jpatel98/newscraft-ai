#!/bin/bash
set -euo pipefail

: "${NEWSCRAFT_APP_PASSWORD:?NEWSCRAFT_APP_PASSWORD is required}"

psql --set=app_password="$NEWSCRAFT_APP_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
SELECT format('CREATE ROLE newscraft_app LOGIN BYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'newscraft_app');
\gexec
-- The SvelteKit server is the trusted database client. Artifact tables keep
-- RLS enabled for anon/authenticated roles, while this server-only role must
-- be able to run the same repository queries as the former Supabase postgres
-- role. Keep it non-superuser and grant only application DML below.
ALTER ROLE newscraft_app BYPASSRLS;
GRANT CONNECT ON DATABASE newscraft TO newscraft_app;
GRANT USAGE ON SCHEMA public TO newscraft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO newscraft_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO newscraft_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO newscraft_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO newscraft_app;
SQL
