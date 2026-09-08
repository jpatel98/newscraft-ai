# NewsCraft Contabo staging

These files define isolated NewsCraft services. They do not reuse the existing
Honcho database, Redis, Hermes, DeepSeek Harness proxy, or Tailscale Funnel
configuration on the personal VPS.

## Services

- `newscraft-postgres/` runs PostgreSQL 17 on `127.0.0.1:55432` with its own
  compose-local `data/` volume. The `newscraft_app` login is a non-superuser
  server role with `BYPASSRLS` so the app can query its server-owned tables;
  the container's `newscraft` role remains the migration/restore administrator.
- `newscraft-storage/` runs the private object gateway on
  `127.0.0.1:9100` with its own compose-local `data/` volume. It supports
  separate `newsroom-documents` and `newsroom-artifacts` policies, one-time
  signed uploads, short-lived signed downloads, immutable object generations,
  and server-only control-plane authentication.

The storage service is intended to be exposed through the dedicated
`/newscraft-storage` path on the existing Tailscale Funnel HTTPS listener;
Tailscale strips that path before forwarding to the gateway. Existing root and
port 8443/DeepSeek Harness routing are intentionally left alone. PostgreSQL
remains loopback-only unless the separately reviewed runtime TLS/network plan
is approved. The administrator database path stays SSH-local.

## Staging order

1. Copy `.env.example` to `.env` on Contabo, generate unique 32-byte secrets,
   and set the storage public URL. Keep the files mode `0600`.
2. Start PostgreSQL and wait for its health check. Restore a verified public
   schema dump into the new database; run the repository migration runner with
   the administrator database credential (never the Vercel runtime credential)
   and compare table counts before any application cutover.
3. Start the storage gateway. Verify `/health`, both private policies, an
   upload/download round trip, and that an expired or reused signed token is
   rejected.
4. Configure the app with `NEWSCRAFT_STORAGE_MODE=vps`, the gateway URL and
   server-only API key in a non-production staging deployment. The existing
   Supabase adapters remain available for rollback until the cutover is
   explicitly approved.

## Fresh host layout

Run `./infra/prepare-layout.sh` as the host operator before starting either
compose project. It creates `newscraft-postgres/data/`,
`newscraft-postgres/backups/`, and `newscraft-storage/data/` with mode `0700`.
The storage tree is assigned to UID:GID `1000:1000`, matching the
`newscraft-storage` compose user. If the PostgreSQL image cannot initialize a
bind mount as its own user, pass the image's numeric owner explicitly with
`--postgres-owner UID:GID`; the script never guesses a host-specific UID.

Copy each service's `.env.example` to `.env` by hand, generate secrets outside
the repository, and run the layout script again. It tightens existing env files
to mode `0600` without creating or copying one. Verify with:

```sh
./infra/verify-layout.sh --require-env
```

`verify-layout.sh` checks the exact directory modes, storage owner, and env-file
permissions. The local `./infra/layout-fixture.test.sh` exercises this setup
without changing the repository's real service directories.

## Database and file reconciliation

`newscraft-postgres/backup-and-restore.sh` creates a new mode-`0600` custom
format dump and restores the public schema additively into the destination. It
refuses to overwrite a dump and does not drop destination objects. Run it with
`SOURCE_DATABASE_URL`, `BACKUP_FILE`, and `DEST_DATABASE_URL` set in the
operator's environment; use the PostgreSQL client major matching the source.
The administrator dump/restore path stays on an SSH-local session. Do not put
an administrator DSN in Vercel.

`sync-storage-files.mjs` is the corresponding additive file reconciliation:

```sh
node infra/sync-storage-files.mjs \
  --source /srv/newscraft-storage-source \
  --destination /srv/newscraft-storage
node infra/sync-storage-files.mjs \
  --source /srv/newscraft-storage-source \
  --destination /srv/newscraft-storage \
  --apply --ack NEWSCRAFT_FINAL_SYNC_ACK
```

The default is a hash-checked plan. Apply copies only missing regular files,
skips `.tokens/`, refuses conflicting destination content, and never deletes
destination-only files. For a rollback-only write, use
`--direction destination-to-source` with the same explicit acknowledgement.
The tool rejects identical, nested, and broad roots. Review the JSON plan and
retain it with the migration record before applying. The synthetic checks are
available through `./infra/test-local-fixtures.sh`.

## NewsCraft-only network and preview plan

The intended public storage address is
`https://contabo.tail9ffe16.ts.net/newscraft-storage`. Tailscale strips that
path before forwarding to the private gateway on `127.0.0.1:9100`; the gateway
must keep generating signed URLs from `NEWSCRAFT_STORAGE_PUBLIC_URL` so the
prefix is preserved. Set `NEWSCRAFT_STORAGE_CORS_ORIGIN` to the app origin
`https://agent.newscraftai.com` (not the landing site). During a Preview check,
it may be a comma-separated exact-origin allowlist containing the app and the
one exact Preview origin; remove the Preview entry after release. Wildcards
are rejected and every response varies on `Origin`. The existing root Funnel
route and private harness route remain untouched.

PostgreSQL remains loopback-only on the host. If a separately approved runtime
TLS path is retained, the only Vercel runtime credential is `newscraft_app` and
the DSN shape is:

```text
postgresql://newscraft_app:<runtime-secret>@contabo.tail9ffe16.ts.net:10000/newscraft?sslmode=verify-full&sslnegotiation=direct
```

Use the hostname that appears in the verified certificate, keep
`sslmode=verify-full`, and prove one authenticated health query from the
Preview environment before production. `pg_dump`/`pg_restore` and migrations
remain SSH-local because the Tailscale TLS-terminated TCP route is not an
administrator backup transport. Preview should receive only
`DATABASE_URL`, `NEWSCRAFT_STORAGE_MODE=vps`,
`NEWSCRAFT_STORAGE_BASE_URL`, `NEWSCRAFT_STORAGE_API_KEY`, and the existing
server-only app secrets; never expose `NEWSCRAFT_STORAGE_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, or an administrator DSN to browser/public vars.

The cutover order is: verify fresh layout, restore and compare DB rows/schema,
reconcile files in plan mode, start and policy-check storage, run Preview
health/upload/download/expiry checks, then take a final additive sync and
switch the runtime mode. Rollback switches `NEWSCRAFT_STORAGE_MODE=supabase`
and the source `DATABASE_URL`, reconciles any explicitly reviewed destination
writes in reverse direction, and preserves both backups. No database is made
public as part of this runbook.

Do not run `docker compose down -v`, remove the source Supabase project, alter
the existing personal services, or expose PostgreSQL publicly as part of this
staging step.
