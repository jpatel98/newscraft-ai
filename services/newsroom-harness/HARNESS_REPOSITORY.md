# Newsroom Harness Repository (Postgres-ready adapter)

The harness repository is local-first by default and can optionally mirror to Postgres.

## Persistence modes

- `sqlite` (default): `NEWSROOM_HARNESS_DATABASE_URL` is empty.
- `sqlite+postgres`:
  - Set `NEWSROOM_HARNESS_DATABASE_URL` to a PostgreSQL DSN.
  - The harness keeps operating on local SQLite at `NEWSROOM_HARNESS_DB_PATH`.
  - On boot, it synchronizes remote `harness.*` rows into local SQLite, then
    keeps local writes mirrored to PostgreSQL asynchronously.

## Production wiring

- Set `NEWSROOM_HARNESS_DATABASE_URL` in the Vercel deployment for harness jobs.
- Keep root app `DATABASE_URL` unchanged; it is for the SvelteKit application DB.
- Keep `NEWSROOM_HARNESS_API_KEY` configured for private endpoint auth.
- For now, the Postgres path is a mirror adapter: production reads still execute
  against local SQLite state and rely on async sync for persistence durability.

## Mirrored tables

The adapter mirrors both state + usage-ledger tables:

- `jobs`
- `runs`
- `run_steps`
- `tool_calls`
- `source_snapshots`
- `sources`
- `reports`
- `events` (append-only)
- `memory_entries` (append-only)
- `usage_ledger` (append-only)

## Local/local-path compatibility

- `createHarnessServer()` returns `repositoryBackend` in the server object.
- `harnessHealth()` reports `db.backend` and `capabilities.persistence` using:
  - `sqlite`
  - `sqlite+postgres`
