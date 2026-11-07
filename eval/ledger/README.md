# Story ledger evaluation

## Offline evaluation

`pnpm eval:ledger` runs the complete ledger suite and is also included in
`pnpm test`. The ledger Vitest configuration disables dotenv loading and does
not initialize SvelteKit. Worker URLs alone do not enable live recording.

Replay uses the production `splitLedgerBlock` extractor: **at most 12 valid
claims per turn**, not every raw claim retained in a recorded fixture. Invalid
claims do not consume that allowance. Golden-label positions refer to the raw
input positions, so rejected claims cannot shift subsequent labels. Raw fixture
tails and reviewed golden labels remain intact; they are not additional stored
claims. Regressions cover the cap, invalid claims, and all 21 fixture/golden pairs.

## Cassette provenance

`offline-cassette-updates.json` records the offline reconciliation after applying
the production cap:

- Three `different` judge verdicts derive from distinct facts in existing
  reviewed golden labels. **They are not new model recordings.**
- Two copy entries are explicitly labeled offline projections of existing
  recordings onto capped requests. Only unreferenced request-tail claims were
  removed. Every response line and claim reference is unchanged; the original
  entries are retained alongside the projected entries.

`cassette.eval.test.ts` verifies golden fact references, judge-pair hashes, old
and new copy-request hashes, unchanged responses, and that removed claims are
not referenced by those responses. No live provider was used for reconciliation.

The existing assertions are unchanged: duplicate rate at most `0.0939`, at most
`14` wrong merges, no missing judge pairs, no unbacked confirmations, and all
`100` copy scripts present with no attribution loss after checking. The targets
remain `0.03` duplicate rate and zero wrong merges. The offline reconciliation
measured `0.0929` and `13`, respectively, with zero missing recordings or
unbacked confirmations and zero attribution loss after checking.

## Optional reports

Default evaluation writes neither `report.json` nor `copy-report.json`.
To emit reports, explicitly select a destination:

```sh
LEDGER_EVAL_REPORT_DIR=/tmp/newscraft-ledger-reports pnpm eval:ledger
```

Only that directory receives the reports. Existing files there may be replaced;
use a separate directory to preserve prior evidence. The initial untracked
reports remain outside commits. The first baseline invocation could regenerate
them before this guard existed; later runs preserve them. See the dated review.

## Explicit live recording

`pnpm eval:ledger:record` requires `LEDGER_EVAL_JUDGE_URL` and explicitly sets
`LEDGER_EVAL_RECORD=1` for Vitest. Supply the worker token privately through
`LEDGER_EVAL_JUDGE_TOKEN`. Copy recording additionally uses
`LEDGER_EVAL_COPY_URL` and `LEDGER_EVAL_COPY_TOKEN`.

This command intentionally permits live worker calls, which may incur provider
charges, and updates cassettes. Do not use it for offline validation. Direct
recording through `pnpm eval:ledger` or the cassette API also requires an
explicit `LEDGER_EVAL_RECORD=1`; report emission remains a separate opt-in.
