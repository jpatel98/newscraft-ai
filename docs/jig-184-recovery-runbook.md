# JIG-184 recovery drill and release matrix

This is the repository-owned, local-only recovery record for JIG-184. It does
not assert that a Supabase project, a VPS, current backups, a private
configuration, or a running Hermes service was inspected. The local command
uses only repository files and disposable synthetic directories. `PASS` means
the stated local contract was exercised; `BLOCKED` means the evidence needs a
separate authority; `FAIL` means an exercised check failed. A required gate is
never converted to `SKIP`.

## Backup-scope inventory

The following is a static inventory, not a backup receipt or a live row count.

### NewsCraft Postgres/Supabase scope

The repository-backed Postgres scope is the NewsCraft control plane. The
schema and durable migration identify these groups:

- identity and access: `accounts`, `organizations`, and
  `organization_members`;
- newsroom content: `conversations`, `messages`, message provenance,
  documents/pages, feedback, diagnostics, and newsroom profiles;
- durable execution: `hermes_runs` and `hermes_run_events`, including the
  saved input, seeded citations, answer/source/citation snapshots, cursors,
  idempotency key, cancellation state, lease fields, and terminal timestamps.

The repository paths supporting this inventory are
`src/lib/server/db/schema.ts`, `drizzle/0015_durable_hermes_runs.sql`, and
`src/lib/server/db/hermes-runs.ts`. The current Supabase project, connection,
schema revision, rows, backup schedule, retention, backup contents, restore
history, and data ownership were not inspected. No database connection,
snapshot restore, migration, row read, or database mutation is part of the
local command.

### NewsCraft Hermes tenant-root and browser-state scope

The checked-in Hermes service contract derives an opaque NewsCraft tenant key
on the server. Per-tenant roots contain the Hermes home, workspace, browser
profile/configuration, skills, plugins, cron/scheduled state, memories, cache,
and temporary workspace state. The browser profile uses a stable tenant-local
session name. NewsCraft authentication and durable conversation/run state
remain authoritative; these Hermes roots are execution state, not a second
NewsCraft database.

This inventory is supported by `services/hermes-chat/README.md` and
`services/hermes-chat/src/hermes_chat/isolation.py`. No real tenant root,
browser profile, workspace, account, tenant key, process state, or VPS path was
read. The local drill creates two synthetic scopes, backs up one, restores
only its synthetic workspace and browser-state files, and proves the other
scope is absent. It records counts and digests only, never scope names or
content.

Hydra is explicitly outside this inventory and outside the backup, restore,
rebuild, rollback, and test boundary. It must not be stopped, inspected,
backed up, restored, or changed by this runbook.

## Versioned evidence contracts

The current contract version is `1`. Every accepted evidence object must be
bound to the exact clean checkout candidate and must be fresh: `captured_at`
may not be more than 24 hours old and may not be more than five minutes in the
future. Digests are lowercase SHA-256 values. No contract permits credentials,
database URLs, raw SQL, prompts, answers, source contents, browser contents,
account IDs, tenant keys, or environment values.

### Isolated Postgres snapshot restore

The validator defines the future, separately authorized evidence shape with
exactly these fields. The current public command does not accept this object,
connect to Postgres, or ingest external evidence.

```json
{
  "schema_version": 1,
  "ticket": "JIG-184",
  "candidate_sha": "<exact-clean-candidate-sha>",
  "source_sha": "<exact-clean-candidate-sha>",
  "captured_at": "<fresh-UTC-timestamp>",
  "execution": "isolated-test-postgres-restore",
  "scope": "disposable-loopback-test-only",
  "test_identity": "dedicated-fixture-only",
  "loopback": true,
  "isolated": true,
  "test_data_only": true,
  "schema": {
    "migration_revision_count": 0,
    "schema_digest": "<sha256>"
  },
  "rows": {
    "table_count": 0,
    "row_count": 0,
    "aggregate_digest": "<sha256>"
  },
  "isolation": {
    "selected_scope_count": 1,
    "foreign_scope_count": 0
  },
  "state": "PASS"
}
```

The local validator additionally requires at least one restored schema table,
exact candidate/source binding, aggregate-only row evidence, and zero foreign
scope rows. It deliberately does not accept a database name, connection URL,
SQL, or credential. No such authorized evidence was supplied for this run, so
`isolated_postgres_snapshot_restore` is `BLOCKED`.

### Synthetic tenant-root restore

The local manifest is also version 1 and has exactly these fields:

```json
{
  "schema_version": 1,
  "ticket": "JIG-184",
  "candidate_sha": "<exact-clean-candidate-sha>",
  "source_sha": "<exact-clean-candidate-sha>",
  "captured_at": "<fresh-UTC-timestamp>",
  "scope": "synthetic-tenant-a",
  "files": [
    {
      "relative_path": "workspace/state.json",
      "kind": "workspace",
      "sha256": "<sha256>",
      "mode": 384
    },
    {
      "relative_path": "browser/state.json",
      "kind": "browser_state",
      "sha256": "<sha256>",
      "mode": 384
    }
  ],
  "manifest_sha256": "<sha256-of-the-canonical-manifest-without-this-field>"
}
```

`384` is decimal JSON notation for file mode `0600`; directories are
`0700`. The validator requires the two exact relative paths, unique entries,
fresh timestamp, matching candidate/source, matching selected synthetic scope,
manifest digest, regular files with one hard link, no symlink in any component,
and no sensitive content. Traversal, absolute paths, backslashes, symlink or
hardlink escapes, extra files, tampering, duplicate entries, stale evidence,
mismatched scope/revision, and secret-bearing artifacts fail closed.

### Pinned Hermes rebuild evidence

The offline repository check binds to Hermes commit
`5370d535ab926da41abe3ba4d9d975f1f94875d5`, the checked-in `uv.lock` digest,
the installer reference, the deployment-unit shape, and a private-settings
shape with zero supplied or serialized values. It checks the pinned package and
import references without invoking the installer. The actual source checkout,
private configuration, VPS rebuild, service start, `/ready` response, and
restart recovery require separate authority and remain
`pinned_hermes_rebuild_start_readiness: BLOCKED`.

This is repository-static evidence only. The current public command does not
accept a private configuration, VPS receipt, service result, or external
Hermes evidence object; it cannot produce `RELEASE`.

The serialized checkout gate is bound to its checkout object: a `PASS` requires
the exact allowed branch `codex/jig-184-recovery` or `main`, the full candidate
and source SHA, the verified base, a clean tree, commit/base presence, and base
ancestry. The repository-static inventory `PASS` is bound to the six checked-in
repository references, three Postgres relation groups, five Hermes state areas,
`BLOCKED` live facts, and the `OUTSIDE_SCOPE` Hydra boundary. Any mismatch is
rejected by the record validator. If checkout identity fails, an unauthorized
branch is redacted to `null` and the checkout gate is `FAIL`.

## Local command and release record

From the exact clean candidate checkout, run:

```text
pnpm canary:jig184 -- --source-sha <exact-clean-candidate-sha> --candidate-sha <exact-clean-candidate-sha>
```

The command reads no database or remote endpoint. It writes one private JSON
record beneath the ignored `.tmp/jig-184` directory with a `0600` file mode
and `0700` directories. The record contains the branch, source/base
identifiers, clean/commit/ancestry checks, aggregate local results, evidence
IDs, gate states, release decision, and safe limitations. It does not contain
paths, URLs, environment values, credentials, tenant/account identifiers,
prompts, answers, browser contents, or raw command output.

The required release gates are:

1. clean candidate checkout identity;
2. repository backup-scope inventory;
3. synthetic tenant restore;
4. offline Hermes repository checks;
5. isolated Postgres snapshot restore;
6. pinned Hermes rebuild/start/readiness;
7. host-loss recovery-time measurement.

The local command is deliberately block-only: it hardcodes the last three
external-authority gates as `BLOCKED`, cannot ingest the future evidence
objects above, always records `BLOCK RELEASE`, and exits `1`. A separately
authorized adapter and drill would be required before those gates could be
evaluated. The versioned evidence validators reject stale or mismatched
evidence, while the record allowlist rejects missing, duplicate, unknown,
forged, unsafe, or extra fields before writing; no current local interface can
authorize `RELEASE`.

## Host-loss drill and manual steps

The following is a future operator runbook. It is not evidence that any step
was run here.

1. Declare the incident and record a monotonic start time. Confirm the
   candidate/source and the last known service identity from an approved,
   secret-free release record. Do not inspect Hydra.
2. Obtain explicit approval before touching traffic, a Vercel alias, a VPS,
   systemd, Caddy, Docker, private configuration, a provider, or a database.
   Without that approval, stop at `BLOCKED`.
3. Obtain an approved backup receipt and restore a snapshot into a disposable,
   isolated Postgres target. Run the version-1 schema/row aggregate and
   foreign-scope checks. Never restore into the production target during a
   recovery drill.
4. Restore exactly one authorized tenant-root backup into a private temporary
   root. Validate the manifest, modes, hashes, path confinement, and absence of
   another tenant's workspace/browser state.
5. Rebuild from the reviewed Hermes source commit and locked dependency
   metadata. Supply private settings through the approved service mechanism;
   record only whether the required shape was supplied, never its values.
6. Start the approved service under its restricted account and verify
   authenticated readiness, one same-run recovery, cancellation, and one
   source/citation check. A real process restart and external endpoint are
   separate gates, not synthetic local evidence.
7. Stop the monotonic timer only after the approved readiness and recovery
   checks pass. Report elapsed RTO, manual steps, waiting time for approvals,
   and any failed or aborted step. Do not impose a flaky wall-clock threshold
   on the disposable local drill.

## Rollback boundaries

Rollback may restore the last approved application/service revision and its
approved configuration, subject to the same change authority. It must not
silently roll back or overwrite Postgres data, change a schema, delete rows,
reuse another tenant's state, or touch Hydra. A database restore is an
isolated recovery action with its own approval and evidence; it is not a
rollback shortcut. If source identity, backup freshness, tenant isolation,
private settings, readiness, or citation checks fail, abort the recovery and
leave the release decision `BLOCK RELEASE`. Traffic changes, deployment or
alias changes, real service control, database actions, and provider actions
require separate approval before the first mutating command.

The local JIG-184 result measures only disposable filesystem work. It is not
production capacity, host-loss RTO, current backup health, current Supabase
state, or live Hermes readiness.
