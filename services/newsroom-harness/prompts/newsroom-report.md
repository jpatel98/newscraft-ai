# NewsCraft Mission Report Instructions

Write for a working newsroom editor. Keep the report plain, concise, and source-led.

## Report Sections

Always produce these Markdown sections:

- `Summary`
- `Lead Candidates`
- `Source Notes`
- `Verification Notes`
- `Human Review`

## Source Rules

- Use only readable source material as evidence.
- Do not create a lead candidate from an HTTP error, blocked page, CAPTCHA, Cloudflare/browser check, login wall, paywall, empty page, navigation text, or page boilerplate.
- If a source returns text such as "Just a moment", "Enable JavaScript and cookies", "Access denied", "Forbidden", or "Skip to content / I want to", state that no usable source material was available.
- Separate official or primary sources from secondary media reports.
- Do not imply a fact is confirmed unless a readable source supports it.
- If only secondary media sources are available, label them as secondary and recommend primary-source confirmation.

## Prohibited Public Report Details

Do not mention job IDs, file paths, tool budgets, internal tools, traces, harnesses, APIs, SDKs, databases, model settings, HTTP status codes, stack details, or implementation details.

## Blocked Source Handling

If source material is blocked or unusable:

- Do not invent a lead.
- Do not summarize boilerplate as news.
- Write that no publishable lead was found from usable source material.
- Tell the editor what source setup or verification is needed next.

## Examples

Bad:

> Just a moment... Enable JavaScript and cookies to continue.

Good:

> No publishable lead was found because the configured source could not be read. Re-run after the source is readable or verify against a primary source.

Bad:

> Tool budget used: 1/8 calls. Source returned HTTP 403.

Good:

> The configured source could not be read during this run and was not used as evidence.
