from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from hermes_chat.retrieval import (
    HttpResponse,
    NewsCraftWebProvider,
    RetrievalConfig,
    VERIFY_LEAD_TOOL_NAME,
    _PublicRedirectHandler,
    retrieval_readiness,
    register,
    verify_this_lead,
)
from hermes_chat.service import _runtime_config


SOURCE_URL = "https://example.test/news/story"
ARTICLE_TEXT = (
    "The source reports a confirmed event with details, timing, and named participants. "
    "The page gives context for the event and explains the next steps for readers. "
    "This paragraph adds enough direct page text to distinguish evidence from a search snippet."
)


def article_html(
    *,
    published: str | None = "2026-08-12T12:00:00Z",
    modified: str | None = None,
    title: str = "Verified source story",
    body: str = ARTICLE_TEXT,
) -> bytes:
    record: dict[str, object] = {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "headline": title,
        "articleBody": body,
    }
    if published:
        record["datePublished"] = published
    if modified:
        record["dateModified"] = modified
    return (
        "<html><head><title>Fallback title</title>"
        f'<script type="application/ld+json">{json.dumps(record)}</script>'
        "</head><body><nav>Menu</nav><article><h1>Visible heading</h1>"
        f"<p>{body}</p></article><footer>Footer</footer></body></html>"
    ).encode()


def response(
    url: str,
    *,
    status: int = 200,
    body: bytes = b"",
    content_type: str = "text/html; charset=utf-8",
    headers: dict[str, str] | None = None,
    error: str | None = None,
) -> HttpResponse:
    return HttpResponse(status, url, {"content-type": content_type, **(headers or {})}, body, error)


class FakeFetcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, float]] = []
        self.live = response(SOURCE_URL, body=article_html())
        self.archive = response(
            "https://web.archive.org/web/20260812120000/https://example.test/news/story",
            body=article_html(),
        )
        self.cdx = response(
            "https://web.archive.org/cdx/search/cdx",
            body=json.dumps(
                [
                    ["timestamp", "original", "mimetype", "statuscode", "digest"],
                    ["20260812120000", SOURCE_URL, "text/html", "200", "digest"],
                ]
            ).encode(),
            content_type="application/json",
        )

    def __call__(self, url: str, timeout: float) -> HttpResponse:
        self.calls.append((url, timeout))
        if "/cdx/search/cdx" in url:
            return self.cdx
        if "web.archive.org/web/" in url:
            return self.archive
        return self.live


class RetrievalTests(unittest.TestCase):
    def provider(self, fetcher: FakeFetcher, **overrides: object) -> NewsCraftWebProvider:
        config = RetrievalConfig(
            live_timeout_ms=2_000,
            archive_timeout_ms=2_000,
            **overrides,
        )
        return NewsCraftWebProvider(
            config=config,
            fetcher=fetcher,
            clock=lambda: datetime(2026, 8, 13, 14, 0, tzinfo=timezone.utc),
        )

    def test_accepts_a_direct_article_and_keeps_provenance(self) -> None:
        fetcher = FakeFetcher()
        result = self.provider(fetcher).verify_lead(SOURCE_URL)

        self.assertNotIn("error", result)
        self.assertEqual(result["metadata"]["evidenceStatus"], "accepted")
        self.assertEqual(result["metadata"]["retrievalMode"], "live")
        self.assertEqual(result["metadata"]["originalUrl"], SOURCE_URL)
        self.assertEqual(result["metadata"]["requestCount"], 1)
        self.assertEqual(result["metadata"]["pageTimestamp"], "2026-08-12T12:00:00Z")
        self.assertEqual(len(fetcher.calls), 1)

    def test_returns_a_bounded_timeout_failure(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(SOURCE_URL, error="timeout")
        result = self.provider(fetcher, archive_fallback=False).verify_lead(SOURCE_URL)

        self.assertEqual(result["error"], "live_timeout")
        self.assertEqual(result["metadata"]["requestCount"], 1)
        self.assertEqual(len(fetcher.calls), 1)

    def test_limits_live_redirects_to_a_bounded_chain(self) -> None:
        self.assertEqual(_PublicRedirectHandler.max_redirections, 5)

    def test_uses_wayback_after_a_blocked_live_page(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(SOURCE_URL, status=403, body=b"Access denied")
        result = self.provider(fetcher).verify_lead(SOURCE_URL, expected_timestamp="2026-08-12")

        self.assertNotIn("error", result)
        metadata = result["metadata"]
        self.assertEqual(metadata["retrievalMode"], "archive")
        self.assertEqual(metadata["fallbackReason"], "live_blocked_http_403")
        self.assertEqual(metadata["archivedUrl"], fetcher.archive.url)
        self.assertEqual(metadata["captureTimestamp"], "2026-08-12T12:00:00Z")
        self.assertEqual(metadata["retrievalTime"], "2026-08-13T14:00:00Z")
        self.assertEqual(metadata["originalUrl"], SOURCE_URL)
        self.assertEqual(metadata["liveStatus"], 403)
        self.assertEqual(metadata["retrievedStatus"], 200)
        self.assertEqual(metadata["requestCount"], 3)

        cdx_query = parse_qs(urlsplit(fetcher.calls[1][0]).query)
        self.assertEqual(cdx_query["closest"], ["20260812000000"])

    def test_reports_an_archive_miss(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(SOURCE_URL, status=403, body=b"Access denied")
        fetcher.cdx = response(
            "https://web.archive.org/cdx/search/cdx",
            body=b"[]",
            content_type="application/json",
        )
        result = self.provider(fetcher).verify_lead(SOURCE_URL)

        self.assertEqual(result["error"], "archive_miss")
        self.assertEqual(result["metadata"]["fallbackReason"], "live_blocked_http_403")
        self.assertEqual(result["metadata"]["requestCount"], 2)
        self.assertEqual(len(fetcher.calls), 2)

    def test_rejects_a_timestamp_mismatch(self) -> None:
        fetcher = FakeFetcher()
        result = self.provider(fetcher).verify_lead(SOURCE_URL, expected_timestamp="2026-08-11")

        self.assertEqual(result["error"], "timestamp_mismatch")
        self.assertEqual(result["metadata"]["timestampStatus"], "mismatch")
        self.assertEqual(result["metadata"]["evidenceStatus"], "rejected")
        self.assertEqual(len(fetcher.calls), 1)

    def test_verify_tool_passes_the_search_timestamp_into_one_bounded_operation(self) -> None:
        fetcher = FakeFetcher()
        provider = self.provider(fetcher)
        with patch("hermes_chat.retrieval._ACTIVE_PROVIDER", provider):
            payload = json.loads(
                verify_this_lead(
                    {
                        "url": SOURCE_URL,
                        "expected_timestamp": "2026-08-11",
                        "expected_title": "Verified source story",
                        "expected_snippet": "A search lead.",
                    }
                )
            )

        self.assertEqual(payload["operation"], VERIFY_LEAD_TOOL_NAME)
        self.assertEqual(payload["results"][0]["error"], "timestamp_mismatch")
        self.assertEqual(payload["results"][0]["metadata"]["timestampStatus"], "mismatch")
        self.assertEqual(len(fetcher.calls), 1)

    def test_rejects_an_article_without_a_timestamp(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(SOURCE_URL, body=article_html(published=None))
        result = self.provider(fetcher).verify_lead(SOURCE_URL)

        self.assertEqual(result["error"], "unknown_timestamp")
        self.assertEqual(result["metadata"]["timestampStatus"], "unknown")
        self.assertEqual(result["metadata"]["pageQuality"], "article")

    def test_uses_a_last_modified_header_as_the_page_timestamp(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(
            SOURCE_URL,
            body=article_html(published=None),
            headers={"last-modified": "Wed, 12 Aug 2026 12:00:00 GMT"},
        )
        result = self.provider(fetcher).verify_lead(SOURCE_URL)

        self.assertNotIn("error", result)
        self.assertEqual(result["metadata"]["updatedAt"], "2026-08-12T12:00:00Z")
        self.assertEqual(result["metadata"]["pageTimestamp"], "2026-08-12T12:00:00Z")

    def test_does_not_accept_a_json_ld_description_as_page_evidence(self) -> None:
        fetcher = FakeFetcher()
        description = "A search result description that is long enough to look like page content. " * 8
        body = (
            "<html><head><script type='application/ld+json'>"
            + json.dumps(
                {
                    "@type": "NewsArticle",
                    "headline": "Description only",
                    "description": description,
                    "datePublished": "2026-08-12T12:00:00Z",
                }
            )
            + "</script></head><body></body></html>"
        ).encode()
        fetcher.live = response(SOURCE_URL, body=body)
        result = self.provider(fetcher).verify_lead(SOURCE_URL)

        self.assertEqual(result["error"], "snippet_only")
        self.assertEqual(result["metadata"]["evidenceStatus"], "rejected")

    def test_rejects_snippet_only_content(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(
            SOURCE_URL,
            body=b"<html><head><meta name='description' content='A search lead.'></head><body>A search lead.</body></html>",
        )
        result = self.provider(fetcher).verify_lead(
            SOURCE_URL,
            expected_snippet="A search lead.",
        )

        self.assertEqual(result["error"], "snippet_only")
        self.assertIn("newscraft-retrieval:v1:", result["content"])

    def test_deduplicates_duplicate_urls_without_a_second_request(self) -> None:
        fetcher = FakeFetcher()
        result = self.provider(fetcher).extract([SOURCE_URL, SOURCE_URL])

        self.assertEqual(len(result), 1)
        self.assertEqual(len(fetcher.calls), 1)

    def test_returns_hermes_provider_results_without_an_extra_envelope(self) -> None:
        fetcher = FakeFetcher()
        result = self.provider(fetcher).extract([SOURCE_URL])

        self.assertIsInstance(result, list)
        self.assertEqual(result[0]["url"], SOURCE_URL)
        self.assertNotIn("results", result[0])

    def test_rejects_more_than_the_bounded_url_limit(self) -> None:
        fetcher = FakeFetcher()
        result = self.provider(fetcher).extract([f"https://example.test/{index}" for index in range(6)])

        self.assertEqual(result[0]["error"], "url_limit_exceeded")
        self.assertEqual(fetcher.calls, [])

    def test_configuration_validation_is_bounded_and_has_no_secret(self) -> None:
        with patch.dict(
            os.environ,
            {
                "NEWSCRAFT_RETRIEVAL_LIVE_TIMEOUT_MS": "1000",
                "NEWSCRAFT_RETRIEVAL_MAX_URLS": "6",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "NEWSCRAFT_RETRIEVAL_LIVE_TIMEOUT_MS"):
                RetrievalConfig.from_env()

    def test_runtime_config_explicitly_selects_the_local_extract_backend(self) -> None:
        config = _runtime_config({"web": {"search_backend": "ddgs"}}, set(), None)

        self.assertEqual(
            config["web"],
            {
                "backend": "ddgs",
                "search_backend": "ddgs",
                "extract_backend": "newscraft-local",
            },
        )
        self.assertIn("newscraft-web", config["plugins"]["enabled"])

    def test_plugin_registers_the_provider_and_bounded_verification_tool(self) -> None:
        class FakeContext:
            def __init__(self) -> None:
                self.providers: list[object] = []
                self.tools: list[dict[str, object]] = []

            def register_web_search_provider(self, provider: object) -> None:
                self.providers.append(provider)

            def register_tool(self, **tool: object) -> None:
                self.tools.append(tool)

        context = FakeContext()
        register(context)

        self.assertEqual(len(context.providers), 1)
        self.assertEqual(context.tools[0]["name"], VERIFY_LEAD_TOOL_NAME)
        self.assertEqual(context.tools[0]["toolset"], "hermes-acp")
        self.assertEqual(context.tools[0]["schema"]["parameters"]["required"], ["url"])

    def test_plugin_readiness_fails_closed_without_a_loaded_hermes_registry(self) -> None:
        readiness = retrieval_readiness(RetrievalConfig())

        self.assertFalse(readiness["configured"])
        self.assertIn(readiness["reason"], {"hermes_registry_unavailable", "plugin_not_registered"})


if __name__ == "__main__":
    unittest.main()
