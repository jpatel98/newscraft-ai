"""Search finds leads; NewsCraft fetch/excerpt checks remain independent."""
from __future__ import annotations
import json
import os
from typing import Any, Protocol
import httpx
from .retrieval import _default_search, validate_public_url


class SearchAdapter(Protocol):
    def __call__(self, query: str, max_results: int, timeout_seconds: float) -> list[dict[str, Any]]: ...


class PublicSearch:
    """Existing DDGS public search; no model provider account is required."""
    def __call__(self, query, max_results, timeout_seconds):
        return _default_search(query, max_results, timeout_seconds)


class OpenAISearch:
    """Optional bounded Responses search adapter, separate from the model loop."""
    def __init__(self, *, api_key: str, model: str, base_url: str = "https://api.openai.com/v1", transport=None):
        self.api_key, self.model, self.base_url, self.transport = api_key, model, base_url, transport

    def __call__(self, query, max_results, timeout_seconds):
        with httpx.Client(timeout=timeout_seconds, trust_env=False, follow_redirects=False, transport=self.transport) as client:
            with client.stream("POST", self.base_url.rstrip("/") + "/responses",
                headers={"authorization": f"Bearer {self.api_key}"}, json={"model": self.model, "store": False, "service_tier": "default",
                    "input": "Find public source pages for this query. Return source links; snippets are only leads. Query: " + query,
                    "tools": [{"type": "web_search", "search_context_size": "low"}],
                    "tool_choice": "required", "max_tool_calls": 1, "max_output_tokens": 2000}) as response:
                if response.status_code >= 400:
                    raise RuntimeError("Search service is unavailable.")
                raw = bytearray()
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 512_000:
                        raise RuntimeError("Search response exceeded its bound.")
        body = json.loads(raw)
        results, seen = [], set()
        for item in body.get("output", []):
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            for part in item.get("content", []):
                for source in part.get("annotations", []) if isinstance(part, dict) else []:
                    if not isinstance(source, dict) or source.get("type") != "url_citation":
                        continue
                    try:
                        url = validate_public_url(source.get("url", ""))
                    except (ValueError, TypeError, AttributeError):
                        continue
                    if url not in seen:
                        seen.add(url)
                        results.append({"url": url, "title": source.get("title", url), "snippet": ""})
        return results[:max_results]


def exa_body(query: str, *, results: int = 6, since: str | None = None, max_characters: int = 4000,
             include_domains: list[str] | None = None, exclude_domains: list[str] | None = None) -> dict[str, Any]:
    """The Exa /search request body (pure, so the filters can be tested without a network)."""
    body: dict[str, Any] = {"query": query[:500], "numResults": results, "type": "auto",
                            "contents": {"text": {"maxCharacters": max_characters}}}
    if since:
        body["startPublishedDate"] = since
    if include_domains:
        body["includeDomains"] = list(include_domains)[:10]
    elif exclude_domains:  # Exa takes one or the other.
        body["excludeDomains"] = list(exclude_domains)[:20]
    return body


async def exa_pages(api_key: str, query: str, *, results: int = 6, since: str | None = None,
                    max_characters: int = 4000, timeout_seconds: float = 8,
                    include_domains: list[str] | None = None, exclude_domains: list[str] | None = None,
                    transport: httpx.AsyncBaseTransport | None = None) -> list[dict[str, Any]]:
    """One Exa request returning ranked pages with their text (fast-path research)."""
    body = exa_body(query, results=results, since=since, max_characters=max_characters, include_domains=include_domains,
                    exclude_domains=exclude_domains)
    async with httpx.AsyncClient(timeout=timeout_seconds, trust_env=False, transport=transport) as client:
        response = await client.post("https://api.exa.ai/search", json=body,
                                     headers={"x-api-key": api_key, "content-type": "application/json"})
    response.raise_for_status()
    pages = []
    for item in response.json().get("results", []):
        url, text = item.get("url"), item.get("text")
        if not isinstance(url, str) or not isinstance(text, str) or len(text.strip()) < 200:
            continue
        try:
            validate_public_url(url)
        except ValueError:
            continue
        pages.append({"url": url, "title": str(item.get("title") or url)[:400], "text": text,
                      "publishedAt": item.get("publishedDate")})
    return pages


# ---------------------------------------------------------------------------
# Provider registries. The runner never reads search credentials itself: it is
# handed one PageSearch (pages with text) and one lead searcher (URLs only),
# chosen here from configuration. Adding a provider means adding one entry.
# ---------------------------------------------------------------------------


class PageSearch(Protocol):
    """Search that returns ranked pages with their readable text."""
    name: str

    async def pages(self, query: str, *, results: int = 6, since: str | None = None, max_characters: int = 4000,
                    include_domains: list[str] | None = None,
                    exclude_domains: list[str] | None = None) -> list[dict[str, Any]]: ...


class ExaPageSearch:
    name = "exa"

    def __init__(self, api_key: str, *, fetch=None):
        self.api_key, self.fetch = api_key, fetch

    async def pages(self, query, **options):
        return await (self.fetch or exa_pages)(self.api_key, query, **options)


def _exa_from_env(env):
    key = env.get("EXA_API_KEY", "").strip()
    return ExaPageSearch(key) if key else None


PAGE_SEARCH_PROVIDERS = {"exa": _exa_from_env, "none": lambda env: None}


def page_search_from_env(env=None) -> PageSearch | None:
    """The configured PageSearch (NEWSCRAFT_AGENT_PAGE_SEARCH, default exa), or None when it has no credentials."""
    env = os.environ if env is None else env
    name = env.get("NEWSCRAFT_AGENT_PAGE_SEARCH", "exa").strip().lower() or "exa"
    if name not in PAGE_SEARCH_PROVIDERS:
        raise RuntimeError(f"NEWSCRAFT_AGENT_PAGE_SEARCH must be one of {', '.join(sorted(PAGE_SEARCH_PROVIDERS))}")
    return PAGE_SEARCH_PROVIDERS[name](env)


LEAD_SEARCH_PROVIDERS = {
    "public": lambda settings: PublicSearch(),
    "openai": lambda settings: OpenAISearch(api_key=settings.search_api_key, model=settings.search_model,
                                            base_url=settings.search_base_url),
}


def lead_search_from_settings(settings) -> SearchAdapter:
    """The lead searcher named by settings.web_provider (public or openai)."""
    return LEAD_SEARCH_PROVIDERS[settings.web_provider](settings)
