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
