# NewsCraft Contabo migration readiness — 2026-09-07

This is a durable, non-secret implementation and readiness record for the
isolated NewsCraft Postgres and private storage services. It is not proof of a
production release. No credentials, tokens, DSNs containing passwords, or
private object names are recorded here.

## Candidate delivered locally

- The document download redirect now validates its signed URL against the
  backend selected by `NEWSCRAFT_STORAGE_MODE`. A stale VPS base URL cannot
  reject a valid Supabase rollback URL, and VPS URLs still receive strict
  origin/path validation.
- `VpsStorageClient` preserves a configured gateway path prefix (for example
  `/newscraft-storage`) for control-plane requests and signed URLs. A signed
  URL with the correct origin but the wrong prefix is rejected.
- `prepare-layout.sh` and `verify-layout.sh` establish and check mode-`0700`
  Postgres data/backups and storage data directories, storage ownership
  `1000:1000`, and mode-`0600` service env files without generating secrets.
- `sync-storage-files.mjs` produces a JSON hash manifest by default and has an
  explicit acknowledgement gate for additive apply and reverse rollback
  reconciliation. It skips `.tokens/`, never deletes destination-only files,
  and never overwrites conflicts.
- The storage gateway accepts a comma-separated exact-origin CORS allowlist,
  reflects only the matching request origin, emits `Vary: Origin`, and rejects
  wildcard configuration. Production should retain only
  `https://agent.newscraftai.com`; an exact Preview origin may be added for the
  isolated check and removed afterward.
- Local PostgreSQL bootstrap and backup/restore fixtures use isolated temporary
  PostgreSQL 17 clusters, verify the `newscraft_app` role/default grants, and
  compare restored rows and schema. The backup fixture also exercises forward
  and reverse file reconciliation.

## Local verification record

Run from the repository root:

```sh
./infra/test-local-fixtures.sh
corepack pnpm test
corepack pnpm check
corepack pnpm build
```

The fixture command is the minimum migration acceptance gate. The route and
storage-client tests cover both Supabase-with-a-stale-VPS-base and VPS modes,
including prefixed gateway URLs. `pnpm check` and `pnpm build` are required
before a release handoff; optional native-module/large-chunk warnings do not
replace a failed check with a pass.

## Network and TLS plan (NewsCraft only)

The target storage URL is
`https://contabo.tail9ffe16.ts.net/newscraft-storage`. The Funnel path is
stripped before forwarding to the private gateway at `127.0.0.1:9100`, so the
gateway itself continues to serve `/health` and `/v1/*` at its root while
signed URLs retain the external prefix. CORS is restricted to
`https://agent.newscraftai.com`. Existing root and private harness routes are
outside this migration scope.

PostgreSQL remains bound to loopback on the host. If the separately approved
runtime-only TLS route on port `10000` is kept, the runtime DSN shape is:

```text
postgresql://newscraft_app:<runtime-secret>@contabo.tail9ffe16.ts.net:10000/newscraft?sslmode=verify-full&sslnegotiation=direct
```

The hostname must match the verified certificate. Validate one authenticated
query from the NewsCraft Preview environment with `sslmode=verify-full` before
switching production traffic. Keep `pg_dump`, `pg_restore`, and migration
administration on an SSH-local session; the runtime route is not a backup
transport. Use only the non-superuser `newscraft_app` login at runtime.

Preview's server-only variables are the existing names
`DATABASE_URL`, `NEWSCRAFT_STORAGE_MODE`, `NEWSCRAFT_STORAGE_BASE_URL`,
`NEWSCRAFT_STORAGE_API_KEY`, and the existing app/Hermes secrets. Do not add
browser/public variants for any of them, and do not put an administrator DSN or
the Supabase service-role key in Preview runtime configuration.

## Cutover and rollback

1. On the target host, copy the two env examples manually, generate unique
   secrets, run `prepare-layout.sh`, and require `verify-layout.sh --require-env`.
2. Back up the source public schema to a new mode-`0600` file, restore into a
   fresh isolated destination, and compare table/row/schema checksums.
3. Run the storage sync tool in plan mode; investigate every conflict and
   destination-only object. Apply only the reviewed plan with
   `--ack NEWSCRAFT_FINAL_SYNC_ACK`, retaining the JSON manifest.
4. Start the private gateway, verify policy privacy, and test signed upload,
   download, expiry, and token reuse. Verify Preview health and one complete
   PDF/artifact round trip before any runtime switch.
5. Take a final additive sync, switch `NEWSCRAFT_STORAGE_MODE=vps`, and use
   the runtime-only DSN only after the TLS query and migration checks pass.

For rollback, switch the runtime `NEWSCRAFT_STORAGE_MODE` and `DATABASE_URL`
back to the verified Supabase/source values, restart the app, and confirm the
Supabase PDF download path. Review any writes made only on the VPS, then run
`sync-storage-files.mjs --direction destination-to-source` in plan mode and
apply the explicitly approved missing files. Never delete destination-only
files or drop the source database as part of rollback.

## Current blockers and evidence boundaries

The local candidate is ready for review and local commit. The remaining release
proof is environmental: confirm the exact certificate/DSN behavior from the
Preview deployment, verify production variables by names and health (without
printing values), and record the final deployment/alias and migration backup
identities. A historical production health check for
`agent.newscraftai.com` returned HTTP 200, while a branch Preview without its
required environment returned an internal error; those observations are not
standing proof after a configuration change and must be refreshed at handoff.

Do not expose PostgreSQL publicly, reuse the personal VPS services, remove the
Supabase source, or treat a successful local fixture as production evidence.
