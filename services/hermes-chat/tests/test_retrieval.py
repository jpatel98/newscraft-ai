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
    _challenge_reason,
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

    def test_retrieval_outcomes_form_a_deterministic_local_matrix(self) -> None:
        malformed_body = ("<html><body><div>Broken page text. " + "Still not an article. " * 24).encode()
        long_direct_body = ARTICLE_TEXT + " " + ARTICLE_TEXT * 2_000
        cases = [
            {
                "name": "direct_readable_page",
                "live": response(SOURCE_URL, body=article_html(body=long_direct_body)),
                "expected_error": None,
                "expected_status": "accepted",
                "request_count": 1,
                "page_timestamp": "2026-08-12T12:00:00Z",
            },
            {
                "name": "bot_block",
                "live": response(
                    SOURCE_URL,
                    body=b"<html><body>Just a moment. Verify you are human.</body></html>",
                ),
                "archive_fallback": False,
                "expected_error": "live_blocked_challenge",
                "expected_status": "unreadable",
                "request_count": 1,
            },
            {
                "name": "paywall",
                "live": response(
                    SOURCE_URL,
                    body=article_html(
                        title="Subscriber access",
                        body=(
                            "Please subscribe to continue reading this article. "
                            "This article is available only to subscribers. "
                            + "Access to the remaining report requires an active subscription. " * 12
                        ),
                    ),
                ),
                "archive_fallback": False,
                "expected_error": "live_paywall",
                "expected_status": "unreadable",
                "request_count": 1,
            },
            {
                "name": "malformed_page",
                "live": response(SOURCE_URL, body=malformed_body),
                "archive_fallback": False,
                "expected_error": "page_quality",
                "expected_status": "rejected",
                "request_count": 1,
            },
            {
                "name": "missing_timestamp",
                "live": response(SOURCE_URL, body=article_html(published=None)),
                "archive_fallback": False,
                "expected_error": "unknown_timestamp",
                "expected_status": "rejected",
                "request_count": 1,
            },
            {
                "name": "old_article",
                "live": response(SOURCE_URL, body=article_html(published="2025-01-01T12:00:00Z")),
                "expected_timestamp": "2026-08-12",
                "archive_fallback": False,
                "expected_error": "timestamp_mismatch",
                "expected_status": "rejected",
                "request_count": 1,
                "page_timestamp": "2025-01-01T12:00:00Z",
            },
            {
                "name": "conflicting_timestamp",
                "live": response(
                    SOURCE_URL,
                    body=article_html(published="2026-08-01T12:00:00Z", modified="2026-08-12T12:00:00Z"),
                ),
                "expected_timestamp": "2026-08-12",
                "archive_fallback": False,
                "expected_error": None,
                "expected_status": "accepted",
                "request_count": 1,
                "page_timestamp": "2026-08-12T12:00:00Z",
            },
            {
                "name": "timeout",
                "live": response(SOURCE_URL, error="timeout"),
                "archive_fallback": False,
                "expected_error": "live_timeout",
                "expected_status": "unreadable",
                "request_count": 1,
            },
            {
                "name": "provider_failure",
                "live": response(SOURCE_URL, error="network_error"),
                "archive_fallback": False,
                "expected_error": "live_network_error",
                "expected_status": "unreadable",
                "request_count": 1,
            },
            {
                "name": "archive_hit",
                "live": response(SOURCE_URL, status=403, body=b"Access denied"),
                "expected_timestamp": "2026-08-12",
                "expected_error": None,
                "expected_status": "accepted",
                "request_count": 3,
                "page_timestamp": "2026-08-12T12:00:00Z",
                "archive_hit": True,
            },
            {
                "name": "archive_miss",
                "live": response(SOURCE_URL, status=403, body=b"Access denied"),
                "expected_error": "archive_miss",
                "expected_status": "unreadable",
                "request_count": 2,
                "archive_miss": True,
            },
            {
                "name": "duplicate_url",
                "operation": "extract",
            },
        ]

        for case in cases:
            with self.subTest(outcome=case["name"]):
                fetcher = FakeFetcher()
                fetcher.live = case.get("live", fetcher.live)
                if case.get("archive_miss"):
                    fetcher.cdx = response(
                        "https://web.archive.org/cdx/search/cdx",
                        body=b"[]",
                        content_type="application/json",
                    )

                provider = self.provider(fetcher, archive_fallback=case.get("archive_fallback", True))
                if case.get("operation") == "extract":
                    results = provider.extract([SOURCE_URL, SOURCE_URL])
                    self.assertEqual(len(results), 1)
                    self.assertEqual(len(fetcher.calls), 1)
                    self.assertEqual(results[0]["metadata"]["evidenceStatus"], "accepted")
                    continue

                result = provider.verify_lead(
                    SOURCE_URL,
                    expected_timestamp=case.get("expected_timestamp"),
                )
                metadata = result["metadata"]
                self.assertEqual(metadata["originalUrl"], SOURCE_URL)
                self.assertEqual(metadata["requestCount"], case["request_count"])
                self.assertEqual(metadata["evidenceStatus"], case["expected_status"])
                if case["expected_error"] is None:
                    self.assertNotIn("error", result)
                    self.assertIn("confirmed event", result["content"])
                    self.assertNotEqual(metadata["pageTimestamp"], metadata["retrievalTime"])
                    self.assertLessEqual(len(result["content"]), 61_000)
                else:
                    self.assertEqual(result["error"], case["expected_error"])
                if "page_timestamp" in case:
                    self.assertEqual(metadata["pageTimestamp"], case["page_timestamp"])
                if case.get("archive_hit"):
                    self.assertEqual(metadata["originalUrl"], SOURCE_URL)
                    self.assertEqual(metadata["archivedUrl"], fetcher.archive.url)
                    self.assertEqual(metadata["fallbackReason"], "live_blocked_http_403")
                    self.assertEqual(metadata["retrievalMode"], "archive")
                if case.get("archive_miss"):
                    self.assertIsNone(metadata["archivedUrl"])
                    self.assertEqual(metadata["fallbackReason"], "live_blocked_http_403")
                if case["name"] == "conflicting_timestamp":
                    self.assertEqual(metadata["publishedAt"], "2026-08-01T12:00:00Z")
                    self.assertEqual(metadata["updatedAt"], "2026-08-12T12:00:00Z")

    def test_accepts_an_article_that_discusses_paywalls_and_subscription_policy(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(
            SOURCE_URL,
            body=article_html(
                title="Why news paywalls matter",
                body=(
                    ARTICLE_TEXT
                    + " This analysis explains how a paywall supports local reporting and what readers should know "
                    + "about subscription policy and subscriber access."
                ),
            ),
        )

        self.assertIsNone(_challenge_reason(fetcher.live))
        result = self.provider(fetcher, archive_fallback=False).verify_lead(SOURCE_URL)

        self.assertNotIn("error", result)
        self.assertEqual(result["metadata"]["evidenceStatus"], "accepted")
        self.assertEqual(result["metadata"]["requestCount"], 1)

    def test_rejects_a_true_200_subscriber_wall_without_bypassing_it(self) -> None:
        fetcher = FakeFetcher()
        fetcher.live = response(
            SOURCE_URL,
            body=article_html(
                title="Subscriber access",
                body=(
                    "Please subscribe to continue reading this article. "
                    "This article is available only to subscribers. "
                    + "Access to the remaining report requires an active subscription. " * 12
                ),
            ),
        )

        self.assertEqual(_challenge_reason(fetcher.live), "live_paywall")
        result = self.provider(fetcher, archive_fallback=False).verify_lead(SOURCE_URL)

        self.assertEqual(result["error"], "live_paywall")
        self.assertEqual(result["metadata"]["evidenceStatus"], "unreadable")
        self.assertEqual(result["metadata"]["retrievedStatus"], 200)
        self.assertEqual(result["metadata"]["requestCount"], 1)
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
        self.assertNotIn("A search lead.", result["content"])

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
