# Provider-neutral NewsCraft setup

The filename is retained for existing links; the managed Agents design is superseded. NewsCraft owns orchestration and durable state. The authorized new database is initialized. The 2026-10-07 local follow-up verified TLS connectivity, both loopback health endpoints, signup/sign-in, and an empty saved conversation, then stopped both services. DeepSeek support below is fixture-verified; its key and separately approved paid acceptance remain pending. No paid API call or public deployment was performed.

For this checkout, the [local setup handoff](agent-local-handoff.md) has a prepared fresh Python environment, guarded local profile, executable commands and the exact remaining approvals. Its checker never falls back to the old database.

## Core setup

1. For this checkout, use the already initialized Supabase project `newscraft-agent` (`ygsiifvjzdazfxflmpjq`, Free, Ohio). Jigar saved its server-only `DATABASE_URL`; the local handoff records the verified public CA configuration required with `sslmode=verify-full`. Supabase is optional for the product. Do not target, restore, delete or migrate data from the inactive old project.
2. **Initialization is complete; do not rerun it.** The prior initialization handoff reports applying the exact [combined initial-schema artifact](../services/hermes-chat/deploy/newscraft-new-project-schema.sql) and verified all 19 migration records, 33 RLS-enabled tables and no browser/public table grants. Its immutable SHA and evidence are recorded in the local handoff. Future separately reviewed schema updates can use `pnpm db:migrate`; that generic runner is **not an empty-project verifier** and does not install Supabase role protections. The schema includes `0017_managed_agent_sessions` (unused historical table) and `0018_portable_agent_core` (run checkpoints and issuer-scoped identity mapping). There is no `db:bootstrap:supabase` command. Migrations do not run on app startup. The workspace lacks the Supabase CLI; core SQL follows the existing explicit Drizzle sequence.
3. Leave `NEWSCRAFT_AUTH_PROVIDER=postgres` for concrete local account/password/session auth. Supply the existing app session signing secret through approved configuration (`APP_SESSION_SECRET`, at least 32 decoded base64 bytes). Signup always creates a member and private per-user organization; it never grants first-user admin or claims legacy data. Local signup does not verify ownership of an email inbox. Signed cookies are checked against revocable DB sessions. Account roles come from the database.
4. Configure the existing private object service with `NEWSCRAFT_STORAGE_PROVIDER=vps`, `NEWSCRAFT_STORAGE_BASE_URL`, `NEWSCRAFT_STORAGE_API_KEY` and the document/artifact buckets. The adapter uses private scoped grants and immutable objects. The existing service must actually be available; this change does not deploy it. Artifact-only development storage can explicitly use `local` with `NEWSCRAFT_ARTIFACT_LOCAL_STORAGE=1` in development; it does not implement PDF storage or a production object service.
5. Match app/worker listener and callback tokens, set the private `/api/internal/hermes/runs` callback URL, and preserve the tenant HMAC secret. Configure separate private worker state/staging roots. Do not put provider keys or storage secrets into browser configuration.
6. Select `NEWSCRAFT_AGENT_MODEL_PROVIDER=openai`, `anthropic` or `deepseek`. OpenAI defaults to `gpt-6-astra`; Anthropic requires an explicit model and `ANTHROPIC_API_KEY`; DeepSeek defaults to `deepseek-flash` and requires its own `DEEPSEEK_API_KEY`. The private `NEWSCRAFT_AGENT_CREDENTIAL_FILE` reader selects only the requested OpenAI/DeepSeek key, without importing the file into the environment. No key is copied, created or substituted from another provider. Review current provider prices and set positive input/output per-million charge ceilings and run limits before readiness can succeed. The default search adapter is `public`. Optional `openai` search separately requires a full per-call price ceiling and an OpenAI key.

Review the official [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Astra model contract](https://developers.openai.com/api/docs/models/gpt-6-astra), or the selected provider’s own pricing. OpenAI model and optional search requests explicitly select `service_tier: default`; Anthropic requests select `service_tier: standard_only`. Price ceilings must cover applicable cache-write and long-context multipliers; do not use a cached-read discount as the input ceiling. Search ceilings cover the entire separate request, including tool charges. These configuration instructions do not authorize a paid call.

A model/provider can change between clean turns. Existing recoverable runs are bound to their original adapter/model/budget policy and will fail safely if those change. Cancellation closes owned work and stops further dispatch; an in-flight direct provider request may still incur its reserved charge. Uncertain model/tool input is not automatically replayed. Durable cancellation is checked under the run-row lock before new model/tool dispatch, while cleanup checkpoints remain accessible to the lease owner. An already admitted immutable publication alone can finalize within its fixed 240-second recovery window (60 seconds per attempt, at most four persisted admissions), even after the original model deadline. New model/research/publication work cannot use that recovery extension. Blocking retrieval cancellation retains the worker slot until the active socket/DNS call drains and forbids subsequent URL/fallback dispatches.

## DeepSeek setup and proposed acceptance

Official docs checked **2026-10-07** list `deepseek-flash` (DeepSeek-V4.1-Flash) and
`deepseek-v4-pro` (DeepSeek-V4-Pro-0813). Both support tool calls. The old
`deepseek-chat` and `deepseek-reasoner` names were retired on 2026-07-24; NewsCraft
rejects them instead of letting the compatibility endpoint silently select a
different model. See the [retirement notice](https://api-docs.deepseek.com/news/news260424/)
and [current model table](https://api-docs.deepseek.com/quick_start/pricing/).

DeepSeek now also documents a [Responses API](https://api-docs.deepseek.com/guides/responses_api/).
This integration reuses the existing Messages translation with a dedicated
DeepSeek adapter: `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic`, sending
`POST /v1/messages`. It explicitly sends `thinking: {type: "disabled"}` and
`max_tokens`, omits `service_tier` and OpenAI encrypted-reasoning fields, and
preserves ordinary tool-call/result pairing. Non-thinking mode supports tools;
no thinking text or signatures enter public history. See
[Messages compatibility](https://api-docs.deepseek.com/guides/anthropic_api/) and
[tool calling](https://api-docs.deepseek.com/guides/tool_calls/).

USD per **million tokens**, from the
[official price table](https://api-docs.deepseek.com/quick_start/pricing/):

| Model / period | Cached input | Uncached input | Output |
| --- | ---: | ---: | ---: |
| Flash, peak | $0.006 | $0.30 | $1.20 |
| Flash, off-peak | $0.003 | $0.15 | $0.60 |
| Pro, peak | $0.044 | $1.32 | $3.96 |
| Pro, off-peak | $0.022 | $0.66 | $1.98 |

Use **peak uncached** input and **peak output** for reservations, regardless of
cache hits or time of day. The worker requires explicit ceilings at least as high
as the selected model's reviewed floors. Higher prices require updating the
reviewed configuration before use; these dated floors cannot track future price
changes automatically. Cache reports or missing responses never refund an
admitted reservation.

Jigar must privately add exactly one entry to
`services/newsroom-harness/.env.local`, replacing the placeholder with the real
key; do not paste the key into chat or a shell command:

```dotenv
DEEPSEEK_API_KEY=<YOUR_REAL_DEEPSEEK_API_KEY>
```

That existing file is only a private credential reference for the owned worker;
this does not select or start the historical newsroom harness. No DeepSeek key
exists yet and none was invented. Existing private profiles are preserved. The
explicit helper option applies the following reviewed DeepSeek settings in
memory: provider `deepseek`, model `deepseek-flash`, Messages base URL above,
input/output ceilings **$0.30/$1.20 per million**, public search, **8** model
requests, **120,000** cumulative reserved input tokens, **2,048** output tokens
per request, **180 seconds**, and **$0.06** maximum local reservation.

```sh
cd /Users/macserver/Development/newscraft-ai
export PATH="/Users/macserver/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$PWD/config/certs/supabase-prod-ca-2021.crt"
node scripts/agent-local.mjs check --provider deepseek
# After configuration passes; startup alone does not approve inference:
node scripts/agent-local.mjs start --provider deepseek
```

The unrounded maximum is
`(120000 × 0.30 + 8 × 2048 × 1.20) / 1000000 = $0.0556608`.
Per-request rounding to microdollars remains below **$0.06**. This is an
application reservation cap, not a provider-enforced billing guarantee or a
guarantee the task will finish before its token/time limits. Paid search is not
part of this profile. Local auth/health tests do not verify model access or file
storage; artifact delivery still needs live validation.

Exact separate approval sentence:

> I approve one public/synthetic DeepSeek acceptance run using deepseek-flash through the Messages API with thinking disabled and public search only, capped at 8 model requests, 120,000 cumulative reserved input tokens, 2,048 output tokens per request, 180 seconds, and a $0.06 application reservation budget at peak ceilings of $0.30/M input and $1.20/M output; no automatic retries or repeat run.

This proposed approval does not authorize deployment, a Linux host change, or
access to prohibited services. If artifact acceptance requires additional
infrastructure permission, resolve that gate separately before starting the paid
run; see [live acceptance boundaries](agent-live-validation-approval.md).

## Optional Supabase adapters

Hosting the database on Supabase requires direct browser table access to remain disabled, independently of selecting these optional adapters. The prior initialization handoff reports applying and verifying [database-only protection](../services/hermes-chat/deploy/supabase-database-private.sql): RLS and revoked public/browser grants, without any Storage/Auth configuration. Preserve it in future schema changes. That prior handoff also reports applying and verifying the narrow revoke of unnecessary browser/public execution grants on the platform auto-RLS function, following the read-only review recorded in the local handoff.

Supabase is neither required nor automatically selected when its environment variables exist. Set `NEWSCRAFT_AUTH_PROVIDER=supabase` and/or `NEWSCRAFT_STORAGE_PROVIDER=supabase` explicitly for the desired adapter. Use only a separately authorized new project. Supply `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` for Auth and server-only `SUPABASE_SECRET_KEY` for storage. `SUPABASE_SERVICE_ROLE_KEY` remains a compatibility alias.

After the protected schema is initialized, separately review and execute `services/hermes-chat/deploy/supabase-adapter.sql` only if selecting Supabase storage. It reasserts public-table protection and creates private `newsroom-documents` and `newsroom-artifacts` buckets. It intentionally grants no direct browser row/object policies; the app verifies identity, ownership and scoped signed grants. Internal account IDs are independent of external Auth UIDs. Identity mapping keys on provider, verified configured issuer/project and subject, never editable metadata or an email match. An email collision does not link accounts automatically. The SQL is not in the generic migration sequence and was not executed.

For Supabase Auth, configure the site URL and exact allowed `https://<app>/auth/callback` redirect. Email-confirmed signup uses default-template PKCE with a per-request HTTPOnly verifier cookie; confirm in the initiating browser. A signup without a session shows “Check your email.” Custom SMTP templates are not assumed. Confirm email-delivery/rate limits separately. Transient Auth verification failures deny access without erasing valid refreshed tokens. Roles remain DB-owned members by default. Legacy administrator invite/setup/delete-user UI paths remain retired; no cloud-user deletion or promotion is automated.

## Isolated computer and remaining live checks

The active runtime has a concrete [rootless OCI terminal/filesystem and interactive browser adapter](../services/hermes-chat/deploy/executor.md). Its scoped snapshots/private browser storage, operation receipts, admission, cancellation, crash recovery and actual-limit guard have deterministic coverage. Browser → verified citation → Markdown/CSV → replay is covered through both model adapters. A pre-provisioned authorized Linux host and live executor/browser acceptance are still required; this Mac is not that host. Browser activation additionally needs an immutable reviewed image and approval of a hash-pinned deny-by-default Chromium user-namespace seccomp profile. No host/policy change has been made. The historical Docker broker is not selected. Research and validated Markdown/CSV rendering do not require an executor.

`node scripts/test-agent-postgres-fixture.mjs` passed 54 real integration checks on a disposable loopback Postgres 16.15 instance, including local signup/session revocation, two-account separation, private checkpoint CAS/lease/cancellation and artifacts. All 19 migrations produced 33 tables. This exposed and fixed the historical artifact migration's assumption that Supabase browser roles exist: the explicit runner now conditionally revokes those roles when present, without modifying historical SQL or the already applied new-project artifact. The fixture was stopped and removed. It does not configure or verify Supabase, production object storage or a provider account.

Local startup is authorized after the passive checker passes; public deployment is prohibited. The local follow-up verified database connectivity, both health endpoints, real local signup/sign-in and an empty saved conversation. It left the disposable records intact and stopped both listeners. Schema and public-table restrictions were not re-audited in that follow-up. Outstanding live checks include two-user row/settings/object isolation, optional Supabase auth, source fetching, provider access, artifact grants/checksums/download and worker recovery. DeepSeek additionally needs its real key. The [public/synthetic live acceptance](agent-live-validation-approval.md) needs separate paid-model approval before inference; no such run has occurred.

## Current local verification

Use the [current handoff Status](agent-local-handoff.md#status-as-of-2026-10-07) for fresh DeepSeek test counts and the earlier measured matrices. Prior implementation logs are historical. No provider/production result is inferred from fixtures.
