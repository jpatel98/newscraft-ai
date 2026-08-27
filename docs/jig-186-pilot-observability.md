# JIG-186 pilot observability

Status: repository definitions only. This document does not claim live pilot,
production, uptime, traffic, or alert delivery.

## Source and SLOs

The latency values come from the roadmap chat quality gate:
[`ROADMAP.md`](../ROADMAP.md#phase-a--chat-excellence-now), lines 341–351.
The source sets TTFT at no more than 3 seconds, total p50 at no more than 12
seconds, and total p90 at no more than 25 seconds for chat-class prompts.

The roadmap does not define a numeric uptime target. The pilot availability SLO
is therefore a transparent derived gate, not an invented production uptime
claim:

- Required readiness availability: **100% of sampled required-readiness results
  in the declared pilot observation window**.
- A healthy sample has HTTP 200 and body `ok: true`. A required component is
  ready when the app database and Hermes core readiness are both ready.
- HTTP 503 with body `ok: false` is an honest unavailable sample. A response
  with a status/body mismatch is a failure and never counts as ready.
- A `degraded` state can still have `ok: true` when only documents or optional
  providers are unavailable. This keeps optional capability separate from
  required service availability.

This 100% pilot gate follows the roadmap rule that nothing else ships until the
chat quality gate holds and the
[`release checklist`](release-and-rollback-checklist.md#one-fail-closed-release-gate)
rule that every required gate must pass. It is a pilot acceptance gate. It is
not a claim about long-term internet uptime. If the product source later
defines a numeric uptime target, replace this derived target and its tests
together.

Latency SLOs for complete runs are:

| Metric | SLO | JIG-182 field |
| --- | ---: | --- |
| First text (TTFT) | `<= 3,000 ms` | `first_answer_ms` |
| Total duration p50 | `<= 12,000 ms` | `total_duration_ms` |
| Total duration p90 | `<= 25,000 ms` | `total_duration_ms` |

Missing stages are not zero and are not successful latency observations.

## Health contract

`GET /api/health` uses one contract for both status and body readiness:

| Layer | Required for `ok: true` | Public response | Authenticated details |
| --- | --- | --- | --- |
| NewsCraft app database | Yes | Only `ok`, `service`, `state`, and `time` | Postgres component and bounded `database_unavailable` class |
| Hermes core readiness | Yes | No runtime or provider details | Hermes status and service name |
| Conversation documents | No | Not disclosed | Separate `documents` capability |
| Search, browser, extraction, lead verification | No | Not disclosed | Separate bounded provider statuses |

`state` is `ready` when required and observed optional capabilities are ready,
`degraded` when required components are ready but an optional capability is not,
and `unavailable` when a required component is not ready. The response status
is 200 for `ok: true` and 503 for `ok: false`. The `capabilities=1` query does
not override this rule. For unauthenticated callers, the state reflects only
the required components because optional checks and details stay behind the
authenticated response.

Hermes `GET /ready` follows the same rule. Its unauthenticated response has
only the redacted summary. Its detailed tools, runtime, provider, and isolation
fields require the server token. Hermes core readiness does not include
provider-backed browser, search, or extraction status. Those values remain
separate capability data.

## Dashboard definitions

The dashboard reads the bounded summary from
[`durable-run-telemetry.ts`](../src/lib/server/durable-run-telemetry.ts). The
machine-readable definitions are in
[`jig-186-observability.ts`](../src/lib/server/jig-186-observability.ts).

| Dashboard metric | Field and aggregation | Missing-data rule |
| --- | --- | --- |
| Queue wait | `queue_wait_ms`; p50 and p90 | Count `queue_wait` in `missing_stages`; do not use zero |
| First progress | `first_progress_ms`; p50 and p90 | Count `first_progress`; do not use zero |
| First text | `first_answer_ms`; p50 and p90 for complete runs | Count `first_answer`; exclude from latency quantiles |
| Total duration | `total_duration_ms`; p50 and p90 for complete runs | Count `total_duration`; exclude from latency quantiles |
| Terminal states | `terminal_state`; bounded category counts | Keep `unknown` visible |
| Restarts | `reconnect_count`; sum and rate per completed run | One reconnecting-to-reconnected cycle counts once; this is not a process restart |
| Failure classes | `failure_class`; bounded category counts | `null` means no failure was recorded |

Usage metadata keeps only bounded provider and tool categories plus counts.
The server trace ID is a controlled correlation field. It is not a tenant,
account, prompt, answer, URL, secret, or dashboard grouping dimension.

## Alert evaluation

The pure evaluator in
[`jig-186-observability.ts`](../src/lib/server/jig-186-observability.ts)
uses a five-minute window and requires three recent samples. It emits no alert
for one cold probe or one incomplete run.

| Alert | Condition | Runbook |
| --- | --- | --- |
| Required availability | The latest three required-readiness samples are false | [`Failure classification`](release-and-rollback-checklist.md#failure-classification) |
| First text latency | The latest three complete runs with this stage exceed 3 seconds | [`Failure classification`](release-and-rollback-checklist.md#failure-classification) |
| Total duration latency | At least three complete runs exist and p50 or p90 breaches its SLO | [`Failure classification`](release-and-rollback-checklist.md#failure-classification) |
| Missing telemetry stage | The same required terminal stage is missing in the latest three terminal runs | [`Failure classification`](release-and-rollback-checklist.md#failure-classification) |

The evaluator returns only bounded alert kind, severity, window, count, stable
reason, and the runbook path. It does not accept or return account IDs, tenant
keys, prompts, answer text, URLs, tokens, provider payloads, or secrets.

No hosted monitoring provider or schema migration is part of JIG-186.
