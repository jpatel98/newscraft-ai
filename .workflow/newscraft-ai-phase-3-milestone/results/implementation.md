Accepted:
- Added a Packager agent that requires an approved draft review gate before producing package outputs.
- Added package history and delivery history story memory keys.
- Added package generation API endpoints:
  - `GET /api/stories/:id/packages?workspace_id=...`
  - `POST /api/stories/:id/packages`
- Added delivery API endpoint:
  - `POST /api/stories/:id/packages/:packageId/deliver`
- Added delivery adapters for email digest, generic webhook, Slack, and WordPress REST draft push.
- Added publish gate enforcement before delivery or CMS push.
- Added editor command routing for Packaging and a `Package story` starter prompt.
- Updated env examples and docs for delivery/CMS configuration.

Rejected:
- No real external delivery calls were made.
- No Linear issues were updated because external writes require approval.

Conflicts:
- None found.

Decisions:
- Delivery credentials and URLs live only in env/config.
- Delivery events and memory store target host, status, response status, and external IDs, but not secret URLs or credentials.
- Resolving a Publish gate records an editor decision; it does not itself send anything externally.

Final changes:
- Harness-owned package generation and delivery workflow.
- Narrow UI command path to invoke packaging from an active workspace.
- Tests covering package outputs, publish gate enforcement, delivery channels, WordPress draft push, and API routing.

Remaining risks:
- Email digest currently prepares locally when no webhook is configured; a production email provider should be configured through `NEWSROOM_EMAIL_DIGEST_WEBHOOK_URL`.
- WordPress custom meta keys may require registration on some WordPress installs; the draft post still creates without relying on meta persistence.
