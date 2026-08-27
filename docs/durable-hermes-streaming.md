# Durable Hermes streaming

## Reproduction

The current browser request owns `POST /api/chat/stream`. The route links
`request.signal` to the upstream Hermes abort controller and calls that
controller from the stream `cancel()` hook. A refresh therefore aborts Hermes.
The route saves only a partial assistant message. The current resume path claims
that row and sends a new Hermes request, so completed research can repeat.

Existing focused evidence before this change:

- `timeout-terminal-contract.test.ts`, `chat-timeouts.test.ts`, and
  `stream.test.ts`: 3 files and 15 tests passed.
- No local UI or Hermes listener was running on ports 3001 or 8000.
- `IDEA.md` was the only untracked file and is preserved.

## Selected ownership model

- NewsCraft Postgres owns authenticated conversations, durable Hermes runs,
  append-only run events, snapshots, leases, and cancellation state.
- The existing restricted `newscraft-hermes-chat.service` owns the Hermes AG-UI
  connection and one worker task per run. It does not use the browser request
  signal.
- The browser calls only NewsCraft. It creates a run, reads a NewsCraft SSE
  subscription, and sends cancellation to NewsCraft.

## Workflow

1. NewsCraft validates the account, conversation, operation, and input. It
   inserts one queued run and its partial assistant row before it asks Hermes
   to execute. A unique account/conversation/idempotency key prevents duplicate
   runs from tabs and retries.
2. NewsCraft sends the same durable run ID, Hermes input, opaque tenant key,
   and authenticated callback contract to the Hermes service. The service
   returns an idempotent acknowledgement and continues independently.
3. The service claims a run with a database-backed lease, keeps the lease alive,
   and posts Hermes events to a server-only NewsCraft callback. NewsCraft
   verifies the service token, binds the event to the run account and tenant,
   allocates the next cursor in one transaction, updates the bounded snapshot,
   and persists the event.
4. `GET /api/chat/runs/:id` replays events after `Last-Event-ID` or the cursor
   query value. It closes only the subscription; disconnect does not cancel the
   run.
5. Conversation load returns the active run snapshot. The page restores the
   persisted answer, sources, status, and cursor, then subscribes to that same
   run ID. A reconnect never calls Hermes start.
6. Explicit cancellation changes the same run to `cancel_requested`, asks the
   Hermes service to cancel that run ID, and records the terminal `cancelled`
   event. Network loss has no such path.
7. On service startup, a bounded recovery poller claims queued or expired
   active runs from NewsCraft. The repository returns candidates in tenant-fair
   oldest-first rounds, so one tenant's backlog cannot fill the recovery batch.
   The worker resumes the same run ID and input. Stored sources and answer
   checkpoints are included so recovery can continue the same stage without
   discarding gathered evidence. If a claimed run cannot fit the current
   capacity, the worker returns its lease through the authenticated release
   route, which persists `queued`, and continues through the batch. A
   serialized continuation runs after capacity is released until the bounded
   recoverable backlog is drained; no locally waiting recovery job holds a
   lease.

## Single-host concurrency and overload

The durable worker admits runs with four explicit limits: four active runs per
Hermes process, two active runs per tenant, sixteen waiting runs per process,
and four waiting runs per tenant. These defaults are conservative until an
authorized live measurement changes them. Waiting jobs use a round-robin
tenant queue, so a noisy tenant cannot consume all active slots or all queue
turns. A full queue returns `429` with code `overloaded`; NewsCraft persists a
safe failed answer state that tells the user to try again shortly.

The local JIG-185 load runner uses the production `DurableRunWorker` with
disposable deterministic provider and callback doubles. Its result is local
scheduler evidence, including recovery backlog refill and tenant fairness, not
production capacity. A second host must not be added until an authorized
single-host production window shows a written threshold miss: p95 admission
wait above 30 seconds, capacity rejection above 1% of accepted runs, any
duplicate invocation or answer, any cross-tenant result, or any
lease/cancellation correctness failure. Until one of those live thresholds is
measured and missed, the single host remains the release decision.

## Low-latency text delivery

Hermes text deltas are coalesced only while they are adjacent. The worker sends
one bounded text event at 4,096 characters or after 50 milliseconds. It sends
structural, citation, tool, terminal, cancellation, failure, and shutdown
events immediately after flushing the text buffer. The unpersisted tail is
therefore bounded to one small batch, and every persisted batch still receives
one monotonic worker cursor.

The NewsCraft subscription polls persisted events every 100 milliseconds. It
still sends the current durable snapshot first and then replays only events
after the supplied cursor. Browser disconnects close only this subscription.

## Release gates

Focused tests come first. Then run concurrency, replay, refresh, duplicate,
cancellation, service-restart, tenant-isolation, typecheck, build, packaging,
and real local and production UI checks. Do not claim release until every
required gate has evidence. Do not change Hydra.
