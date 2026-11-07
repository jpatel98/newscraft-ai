# Cloud evidence workspace — first slice (2026-11-07)

Status: implemented in this repository. The deployment and production
migration receipts are recorded at the bottom as they happen; anything not
listed there has not been verified live.

This is the first vertical slice of the cloud investigations plan
(`NEWSCRAFT_CLOUD_IMPLEMENTATION_PLAN.md`): project-scoped evidence, sealed
by hash, with deterministic, evidence-backed leads and project-scoped chat
context. It builds on production main (`7a39b01`, PR #16). The separate
November 7 review commits on the Mac mini's local `main` (`9532c23..1860f69`)
were **not** merged here; they conflict with the Hermes-to-agent rename and
need their own reconciliation. Two of their fixes that the plan calls out as
early changes were ported: account-scoped thread-title context and one shared
storage-provider selection for issuing and validating download URLs.

## What a reporter gets

On a folder page (`/projects/<id>`):

- **Evidence.** Add PDFs (text layer required) and CSVs to the folder. Each
  file is uploaded straight to the private storage gateway under an opaque key
  (`evidence/<account>/<project>/<id>`; the filename lives only in the
  catalog), then **sealed**: the server recomputes SHA-256 and byte length and
  refuses anything that differs from what the browser declared. A sealed
  document is immutable; finalizing it again is a no-op. PDFs are extracted to
  pages; CSVs to original cell strings with record ordinals and physical line
  numbers, delimiter/header decisions and inferred column types. Inspect any
  page or row window, download the original through a 60-second signed link,
  or remove a file (its citations in leads become “source withdrawn”).
- **Leads.** “Analyze evidence” runs deterministic analyzers over every ready
  file in the folder and **calls no AI model**. It proposes at most three
  ranked leads plus one summary per dataset:
  - possible join between two files (shared identifier values, with companion
    columns such as address compared and disagreements counted);
  - identifier values from a CSV that appear verbatim in a PDF (page cited);
  - repeated identifiers in one file (one card per file);
  - unusual amounts (exact decimal arithmetic, median ± 5 MAD).
  Every card states what was observed, the rule and counts behind the number,
  the exact rows/pages, limitations, and a next question. Reruns refresh
  proposed cards by fingerprint but never reopen something saved, reviewed or
  dismissed. Save, mark reviewed (with a note), dismiss (a reason is required)
  or reopen; each action is attributed to the signed-in account.
- **Ask about this in chat.** Opens a new chat in the folder with a prompt
  that carries the observation, method, evidence pointers and limits.
- **Project chats see project evidence.** A chat filed in a folder receives
  ranked pages and matching rows from that folder's ready evidence as seeded,
  citable sources (`/api/projects/<id>/evidence/<doc>/download`), bounded to
  24k characters per turn. Unfiled chats get none. Attached-PDF behaviour is
  unchanged.

The folder page shows the privacy line reporters see: evidence is stored
privately in NewsCraft's cloud and processed by NewsCraft; analysis uses no AI
provider; chat questions inside the folder send selected excerpts to the
configured model; nothing is published or shared without the user's action.

## Isolation and privacy controls

- Every route resolves the project from the session and path
  (`requireOwnedProject`); the body is never trusted for scope. A foreign or
  forged project id is a 404 before any service call.
- Every repository statement names `account_id` **and** `project_id`.
  Migration 0027 adds composite foreign keys to `projects(id, account_id)` and
  `project_documents(id, account_id, project_id)`, so a page, row, dataset or
  finding cannot be attached to another project even by a direct SQL write.
- Chat context for a conversation is loaded by `(accountId, projectId)` only
  after `getConversationProject` confirms the conversation's own folder.
- Thread-title enrichment is now bound to the account as well as the
  organization (`listRecentConversationSubjects`).
- Download redirects validate the signed URL against the provider that issued
  it, send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Deleting a folder is refused (409) while it still holds evidence; evidence
  must be removed file by file, which also deletes the stored object and
  withdraws excerpts from findings.
- Logs: no filenames, excerpts or signed URLs are written; errors surface as
  fixed codes.

Storage: PDFs use the existing PDF-only bucket; CSVs use the bucket whose
gateway policy already admits `text/csv` (the artifact bucket by default,
override with `NEWSCRAFT_EVIDENCE_CSV_BUCKET`). No gateway change was needed.

## Limits (pilot ceilings, not promises)

| Limit | Value |
| --- | --- |
| PDF | 20 MiB, 250 pages, text layer required (no OCR yet) |
| CSV | 20 MiB, 50,000 records, 200 columns, 10,000 chars per cell, UTF-8 only |
| Per project | 100 files, 1 GiB declared bytes |
| Analysis | 3 ranked leads per run, one run at a time per project |
| Chat evidence context | 24,000 characters per turn |

Not in this slice: stories (sub-scopes inside a project), OCR for scanned
PDFs, background job queue (processing runs inside the finalize request),
embeddings, collaboration/membership, exports/evidence bundles, retention
automation, the storage spike and provider evaluation from the plan.

## Tests

- `src/lib/server/evidence/csv.test.ts` — parser fidelity (leading zeros,
  quotes, multi-line records, BOM, delimiters, ragged rows), rejection of
  non-UTF-8/binary/unterminated input, ceilings, exact decimals.
- `src/lib/server/evidence/analysis.test.ts` — fixture of two procurement
  CSVs and one PDF: exact shared-key count (4), one differing address, three
  identifier mentions with page citations, repeat counts, outliers with exact
  totals, determinism, and no join when overlap is too small.
- `src/lib/server/evidence/service.test.ts` — opaque keys, hash mismatch
  fails closed, sealed documents are not reprocessed, scope on every lookup,
  withdrawal on delete, bounded chat context, single-flight analysis.
- `src/lib/server/evidence/context-isolation.test.ts` — canary strings in
  another project and another account never enter a project A chat context;
  forged scopes yield nothing.
- `src/routes/api/projects/[id]/evidence/evidence-routes.test.ts` — auth,
  ownership, body-supplied scope ignored, type/size validation, download
  origin validation, error mapping, query bounds, dismissal reason.
- `src/routes/api/chat/stream/durable-route.test.ts` — unfiled chats never
  look up evidence; project chats seed their evidence; missing tables degrade
  to no evidence instead of a failed turn.
- `src/lib/server/db/project-evidence.integration.test.ts` (disposable
  Postgres via `node scripts/test-agent-postgres-fixture.mjs`) — sealing,
  search and row reads bound to account+project; database rejects forged
  scope at the FK level; findings scope, review survives reruns, withdrawal
  scrubs excerpts; project B stays invisible to project A; cascade on project
  delete.
- `src/lib/server/db/conversations-subjects.test.ts` — the title predicate
  includes the account.

## Deploying

1. Merge to `main`; Vercel builds production from `main` automatically.
   The app tolerates the missing tables: evidence controls are hidden and
   chats skip evidence until the migration lands.
2. Apply migration `0027_project_evidence` to the production database
   (Contabo `newscraft-postgres`, database `newscraft`) with the guarded
   runner and the administrator credential, from the Mac through an SSH
   tunnel. Back up first; the runner refuses if anything other than 0027 is
   pending.

   ```sh
   # 1. backup on the box (admin user from the compose .env)
   ssh contabo 'U=$(grep -oE "^POSTGRES_USER=.*" ~/services/newscraft-infra/newscraft-postgres/.env | cut -d= -f2);
     D=~/backups/newscraft-pre-evidence-$(date +%Y%m%d); mkdir -p "$D"; chmod 700 "$D";
     docker exec newscraft-postgres pg_dump -U "$U" -Fc newscraft > "$D/newscraft.dump"; ls -la "$D"'
   # 2. tunnel + guarded migration (enter PGUSER/PGPASSWORD privately; nothing is printed)
   ssh -f -N -o ExitOnForwardFailure=yes -L 55433:127.0.0.1:55432 contabo
   cd /Users/macserver/Development/newscraft-ai   # a checkout at or after this change
   PGPORT=55433 PGDATABASE=newscraft PGUSER=… PGPASSWORD=… \
     corepack pnpm --filter @newscraft/newsroom-harness exec tsx \
     ../../scripts/apply-expected-migrations.ts --expect 0027_project_evidence
   ```

   The script prints the ledger count before/after, the six `project_*`
   tables, the `newscraft_app` grants (CRUD arrives through the database's
   default privileges) and RLS state. Rollback:
   `drizzle/rollback/0027_project_evidence.down.sql`.
3. No worker change is required for this slice. No gateway change is
   required.
4. Smoke: open a folder, add a small CSV and a text PDF, confirm Ready with a
   hash, run Analyze, open a lead's rows, ask about it in chat, remove a file
   and confirm the lead shows “source withdrawn”.

## Receipts

- 2026-11-07: branch `claude/cloud-evidence-workspace` pushed; PR #17 opened
  against `main`. CI (`ci`, `worker`) and the Vercel preview build passed.
  Local: `pnpm check` 0/0, vitest 934 passed, shared 37, harness 343, ledger
  eval 9, disposable Postgres fixture 81 passed (46 public tables), build ok.
  The `test:agent` step fails on this Mac for lack of a Python venv at the
  renamed worker path, identically on untouched `main`; the worker is unchanged
  and its CI job passed.
- 2026-11-07: merge to `main` and the production migration were **not**
  performed by the automated session (its permission mode blocks merges and
  production writes). Both remain for Jigar: merge PR #17 (Vercel deploys
  `main` automatically), then run step 2 above, then the smoke test in step 4.
