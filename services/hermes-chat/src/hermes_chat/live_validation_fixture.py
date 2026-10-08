"""Exact in-memory browser fixtures for the opt-in model validator.

These resources never resolve a hostname, open a socket, or fall back to the
public retrieval provider. Their browser receipts are explicitly synthetic.
"""
from __future__ import annotations

import base64
import copy
import hashlib
from dataclasses import replace
from types import MappingProxyType
from typing import Any, Mapping

from .browser_evidence import BROWSER_FIXTURE_PROVENANCE, _is_authentic_browser_receipt
from .browser_network import BrowserNetworkError, GatewayResponse
from .retrieval import NewsCraftWebProvider, RECORD_SOURCE_TOOL_DEFINITION, ResearchTools, RetrievalConfig

SOURCE_URL = "https://fixture.newscraft.example/research-brief"
SCRIPT_URL = "https://fixture.newscraft.example/resources/interactive.js"
STYLE_URL = "https://fixture.newscraft.example/resources/interactive.css"
IMAGE_URL = "https://fixture.newscraft.example/resources/marker.png"
SOURCE_TITLE = "NewsCraft synthetic research fixture"
SOURCE_SENTENCE = "The synthetic observatory recorded seventeen blue lanterns during its controlled evening survey."
SOURCE_DATE = "2026-01-15T12:00:00Z"
SCRIPT_MARKER = "Synthetic JavaScript resource loaded."

ARTICLE_HTML = f"""<!doctype html><html><head><meta charset="utf-8">
<title>{SOURCE_TITLE}</title><meta property="og:type" content="article">
<meta property="article:published_time" content="{SOURCE_DATE}">
<link rel="stylesheet" href="{STYLE_URL}"><script src="{SCRIPT_URL}" defer></script>
</head><body><main><article><h1>{SOURCE_TITLE}</h1>
<p>{SOURCE_SENTENCE}</p>
<p>This entirely invented article is a controlled software validation fixture.
It supplies enough readable source text to check direct browser evidence,
exact supporting excerpts, citation recording, and generated research files.
The lantern count describes no real institution, person, place, or event.
Every resource on this page comes from a fixed in-memory allowlist. Its results
do not verify public Internet access or any production database or storage.</p>
<p id="js-status">JavaScript has not loaded.</p>
<img src="{IMAGE_URL}" alt="Synthetic resource marker" width="20" height="20">
<label>Fill check <input id="fill-check"></label><p id="fill-status">Fill waiting.</p>
<label>Type check <input id="type-check"></label><p id="type-status">Type waiting.</p>
<p id="key-status">Key waiting.</p><button id="click-check" type="button">Reveal fixture marker</button>
<p id="click-status">Click waiting.</p><div class="spacer">Synthetic scroll region.</div>
<p>End of the synthetic scroll fixture.</p></article></main></body></html>"""

_SCRIPT = b"""'use strict';
document.querySelector('#js-status').textContent = 'Synthetic JavaScript resource loaded.';
document.querySelector('#fill-check').addEventListener('input', event => {
  document.querySelector('#fill-status').textContent = 'Fill verified: ' + event.target.value;
});
document.querySelector('#type-check').addEventListener('input', event => {
  document.querySelector('#type-status').textContent = 'Type verified: ' + event.target.value;
});
document.querySelector('#type-check').addEventListener('keydown', event => {
  if (event.key === 'Enter') document.querySelector('#key-status').textContent = 'Enter key verified.';
});
document.querySelector('#click-check').addEventListener('click', () => {
  document.querySelector('#click-status').textContent = 'Click verified.';
});"""
_STYLE = b"body { margin: 24px; color: #123; background: #fff; } .spacer { height: 1600px; background: #def; }"
_IMAGE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQaHgAAAJEAYFxwsaxAAAAAElFTkSuQmCC")
_RESOURCES = MappingProxyType({
    SOURCE_URL: ("text/html; charset=utf-8", ARTICLE_HTML.encode()),
    SCRIPT_URL: ("application/javascript; charset=utf-8", _SCRIPT),
    STYLE_URL: ("text/css; charset=utf-8", _STYLE),
    IMAGE_URL: ("image/png", _IMAGE),
})
ALLOWED_URLS = frozenset(_RESOURCES)


class SyntheticFixture:
    """A gateway callback with no network code or external resource fallback."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str]] = []

    async def fetch(self, url: str, *, method: str = "GET", request_headers: Any = None,
                    timeout_seconds: float = 15) -> GatewayResponse:
        # Reject before consulting resources or doing any work. Exact matching
        # also excludes alternate ports, queries, fragments and redirect URLs.
        if method not in {"GET", "HEAD"} or not isinstance(url, str) or url not in ALLOWED_URLS:
            raise BrowserNetworkError("Synthetic validation permits only exact fixture GET/HEAD resources")
        content_type, content = _RESOURCES[url]
        body = content if method == "GET" else b""
        self.requests.append((url, method))
        return GatewayResponse(url, 200, {"content-type": content_type, "cache-control": "no-store"},
                               body, hashlib.sha256(body).hexdigest())


def _reject_external(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("Public fetch, search and archive access are disabled in synthetic validation")


class FixtureResearchTools(ResearchTools):
    """Only sealed browser evidence can enter this fixture's source ledger."""

    def __init__(self, config: RetrievalConfig | None = None) -> None:
        config = replace(config or RetrievalConfig(), enabled=True, archive_fallback=False)
        super().__init__(config, provider=NewsCraftWebProvider(config, fetcher=_reject_external),
                         searcher=_reject_external)
        self.tool_definitions = [copy.deepcopy(RECORD_SOURCE_TOOL_DEFINITION)]
        self.accepted_receipts: dict[str, Any] = {}

    def remember_browser_receipt(self, receipt: Any) -> None:
        if (not _is_authentic_browser_receipt(receipt) or receipt.final_url != SOURCE_URL
                or receipt.provenance != BROWSER_FIXTURE_PROVENANCE
                or receipt.synthetic_fixture is not True or receipt.public_network_validated is not False):
            raise ValueError("Validation evidence requires an authentic synthetic fixture receipt")
        super().remember_browser_receipt(receipt)
        self.accepted_receipts[receipt.receipt_id] = receipt

    async def execute(self, name: str, args: Mapping[str, Any]) -> str:
        if name != "record_newscraft_source":
            raise ValueError("Synthetic validation exposes only record_newscraft_source research")
        if not isinstance(args, Mapping) or not isinstance(args.get("source"), Mapping) or args["source"].get("url") != SOURCE_URL:
            raise ValueError("Synthetic validation can record only its exact source URL")
        return await super().execute(name, args)

    def verified_sources(self) -> list[dict[str, Any]]:
        """Return sources backed by the host's sealed receipt, for final proof."""
        sources = []
        for source in self.recorded_sources.values():
            retrieval = source.get("retrieval", {})
            receipt = self.accepted_receipts.get(retrieval.get("receiptId"))
            if (receipt is not None and _is_authentic_browser_receipt(receipt)
                    and receipt.navigation_digest == retrieval.get("navigationDigest")
                    and source.get("supportingExcerpt") == SOURCE_SENTENCE):
                sources.append(copy.deepcopy(source))
        return sources
