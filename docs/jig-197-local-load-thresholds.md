# JIG-197 local load and scale-threshold evidence

JIG-197 publishes a repeatable local scheduler measurement. It is not a
production-capacity claim. The runner uses the existing production
DurableRunWorker through the JIG-185 LocalLoadWorker seam with in-process
provider, callback, and recovery doubles. It does not contact a browser,
provider, database, remote endpoint, Docker daemon, or service process.

Run it from a clean, candidate-bound checkout:

    pnpm canary:jig197 --source-sha <full-clean-candidate-sha> --candidate-sha <full-clean-candidate-sha>

The locked equivalent is:

    uv run --locked --project services/hermes-chat python services/hermes-chat/tests/jig_197_load.py --source-sha <full-clean-candidate-sha> --candidate-sha <full-clean-candidate-sha>

The command writes one redacted JSON record below .tmp/jig-197/. The
directory is mode 0700 and each record is mode 0600. The versioned schema
contains only aggregate observations, including queue and completion
percentiles, active/queued peaks, callback counts and delay, completion and
rejection totals, duplicate outcomes, fairness, and a local runner CPU/RSS
observation explicitly marked non-production. It contains no tenant or
account identifiers, inputs, answers, URLs, raw events, environment values,
database paths, credentials, or secrets.

The deterministic matrix covers:

- light and saturated offered load;
- simultaneous synthetic tenants and account/tenant binding rejection;
- slow provider, delayed callbacks, and delayed control-plane calls;
- fair round-robin progress past a noisy tenant;
- bounded overload rejection;
- waiting and active cancellation;
- duplicate-start idempotency with one logical invocation and no duplicate
  answer observation;
- worker reconstruction/recovery;
- a recovery backlog with a noisy tenant ahead of a quiet tenant.

Local scheduler invariants are the configured defaults: at most 4 active
runs, 2 active runs per tenant, 16 queued runs, and 4 queued runs per
tenant. The matrix fails if those bounds, duplicate-start, tenant-binding,
cancellation, fairness, or recovery assertions fail. The observations are
fixture measurements; they do not establish safe production concurrency.

The current public command has no external evidence-ingestion interface, so
the following required gates remain BLOCKED: live single-host safe
concurrency, Postgres latency, real provider/browser latency, real process
restart recovery, production CPU/RSS, producer-workflow cost, and the
scale-out decision. A successful local matrix therefore still produces
BLOCK RELEASE and exits 1. No second host is provisioned or authorized
from fixture evidence.

Production thresholds remain the written gates: investigate when authorized
live admission-wait p95 exceeds 30 seconds, capacity rejection exceeds 1%,
or any duplicate invocation/answer, cross-tenant result, lease failure, or
cancellation correctness failure occurs. Do not add a second host until
authorized live single-host metrics miss those thresholds. Postgres latency,
real provider/browser latency, real restart rate, production CPU/RSS, cost,
and live concurrency require separately authorized evidence.

The only process-like lifecycle exercised by the matrix is constructing and
closing local worker objects. It is labelled reconstruction evidence, not a
real process-restart measurement. JIG-185 remains a formal blocker for live
capacity claims, and Hydra is outside this local measurement boundary.
