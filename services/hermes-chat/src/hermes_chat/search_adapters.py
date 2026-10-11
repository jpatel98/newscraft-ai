"""Search finds leads; NewsCraft fetch/excerpt checks remain independent."""
from __future__ import annotations
import json
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


async def exa_pages(api_key: str, query: str, *, results: int = 6, since: str | None = None,
                    max_characters: int = 4000, timeout_seconds: float = 8) -> list[dict[str, Any]]:
    """One Exa request returning ranked pages with their text (fast-path research)."""
    body: dict[str, Any] = {"query": query[:500], "numResults": results, "type": "auto",
                            "contents": {"text": {"maxCharacters": max_characters}}}
    if since:
        body["startPublishedDate"] = since
    async with httpx.AsyncClient(timeout=timeout_seconds, trust_env=False) as client:
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
