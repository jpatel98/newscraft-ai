# Running tests

Use Node 24 and the pinned pnpm version. Install the locked worker environment
with `cd services/agent && uv sync --frozen`, or use an existing Python 3.11
environment through `NEWSCRAFT_AGENT_PYTHON=/absolute/path/to/python`.

`pnpm test` runs app, shared-package, historical harness, ledger, script, and
owned Python worker tests. It builds the shared package first and stops on the
first failed layer. Missing Python or dependencies fail with setup guidance;
the worker is never silently skipped. Some tests require disposable loopback
listeners. Database-backed and opt-in live JavaScript cases remain skipped
without their separate configuration.

For a narrower change, use `pnpm test:js`, `pnpm test:agent -k tape`, or
`pnpm test:scripts`. CI runs JavaScript and Python in separate jobs with the
same suites. The Python runner canonicalizes the temporary directory so macOS
symlinks do not conflict with isolation checks.

Run `pnpm check` for Svelte/TypeScript checks and `pnpm eval:fixture` for the
historical deterministic golden-prompt evaluation. `pnpm test:e2e` is a
separate browser/database workflow; a passing offline test command does not
establish real provider quality, audio playback, or production readiness.

Test counts are runner methods or cases, not coverage percentages. Table rows
label distinct scenarios without adding to unittest's method count. When
consolidating tests, retain a mapping from removed methods to surviving rows,
and confirm representative injected faults still fail through assertions.

The source-anchored experiments and changed writing prompts remain isolated, outside this release. The baseline exact-prompt broadcast cassette remains an active required replay check.
