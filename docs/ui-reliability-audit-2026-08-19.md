# NewsCraft UI reliability audit — 2026-08-19

## Scope

- Checkout: `/Users/jigar/Development/newscraft-ai`, `main`, commit `59f409bb60767090e6737db3c4b4852bc216ec29`.
- Browser: Codex In-app Browser, local UI at `http://127.0.0.1:4174`.
- Data: isolated local PostgreSQL database `newscraft_ui_audit_20260819`.
- Stream test: localhost-only Hermes mock. The real Hermes service was not changed or contacted.
- Screenshots: `output/playwright/ui-reliability-audit-20260819/`.

## Findings before edits

### F1 — P2: thread document title stays stale after SPA navigation

Reproduction:

1. Sign in.
2. Start a chat from `/` or navigate from the home page to a thread.
3. Read the browser document title.
4. Reload the thread and read the title again.

Observed result:

- After SPA navigation: `New chat · NewsCraft`.
- After a full thread reload: `NewsCraft`.
- The visible thread header is present, but `src/routes/c/[id]/+page.svelte` has no route-level `<svelte:head>` title. The layout title remains authoritative.

Evidence: browser title trace from the in-app Browser; screenshots `08-thread-reload-320x700.png` and `25-stream-cadence-final-390x844.png` show the affected thread view. This is a stale state, not a visual layout failure.

### F2 — P2: mobile action targets are below the 44-pixel touch target

At 390×844, DOM measurements found:

- Mobile command-bar buttons: 36×36 pixels.
- Latest-answer utility controls: 30 pixels high; the Regenerate control measured 33×30 pixels.
- Composer attach/send controls and message action controls: 44 pixels high.

Evidence: screenshot `25-stream-cadence-final-390x844.png` and the in-app Browser DOM bounds measurement. The controls are visible and usable, but the compact controls are smaller than the target size used elsewhere in the mobile UI.

## Verified passes

| Area | Result | Evidence |
|---|---|---|
| Setup and login at 320×700 | Pass | `02-setup-320x700.png`, `03-login-320x700.png` |
| Empty chat and composer | Pass | `04-empty-chat-320x700.png`, `05-composer-multiline-320x700.png` |
| Signup mismatch validation | Pass | `19-signup-320x700.png`, `20-signup-mismatch-320x700.png` |
| Drawer open/close and focus restore | Pass | `06-drawer-open-320x700.png`; focus returned to Toggle sidebar |
| Hermes-unavailable error state | Pass | `07-chat-failure-320x700.png` |
| Back, forward, reload | Pass | browser route and DOM checks; `08-thread-reload-320x700.png` |
| Thread layout at 390, 430, tablet, desktop | Pass | `09`–`12` screenshots; no document overflow |
| Long thread scroll and anchoring | Pass | `15-long-thread-top-fresh-390x844.png`, `13-long-thread-bottom-390x844.png` |
| Long cited answer and evidence dialog | Pass | `17-long-cited-bottom-fresh-390x844.png`, `18-citation-dialog-390x844.png` |
| Durable stream with progress, text deltas, completion | Pass with localhost mock | `24-stream-mid-390x844.png`, `25-stream-cadence-final-390x844.png`; shell bounds stayed fixed at 390×844 |
| Console warnings/errors | Pass | in-app Browser returned no warning or error entries after the audit |

## Limitations and not-run gates

- No physical iPhone or iOS Safari validation. The 320/390/430 checks are desktop in-app Browser viewport emulation.
- The real Hermes service, production data, providers, credentials, and infrastructure were not used.
- Durable reconnect/replay after a dropped subscription, two independent browser tabs, network throttling, 200% browser zoom, and orientation rotation in a physical browser need a later release check. The local visual-viewport behavior was checked through the existing automated viewport path and the in-app Browser bounds.
- The transient screenshot `14-long-thread-top-390x844.png` and the first stream captures missed the fixed lower controls while the DOM bounds were already correct. Stable recaptures are `15`, `17`, and `25`; no layout fix is based on the transient repaint.

## JIG-181 release-matrix boundary

This historical audit is not a release-matrix record for a later candidate. The
repeatable JIG-181 command is `pnpm ui:matrix:jig181`, which uses the dedicated
Playwright configuration, exact checkout identity, bounded layout-shift and
duplicate-request assertions, and a redacted evidence manifest. It requires an
explicit disposable loopback database authority for authenticated browser
execution. The named physical-device gate remains separate: desktop viewport
emulation and this audit cannot satisfy the required iPhone 17 Pro / Safari
check.
