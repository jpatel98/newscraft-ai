from __future__ import annotations
import json
import unittest
from datetime import datetime, timezone

import httpx

from hermes_chat import research_plan
from hermes_chat.search_adapters import exa_body, exa_pages
from hermes_chat.source_tiers import (normalize_domains, official_domains_for_query, rank_pages, source_type_for_tier,
                                      tier_for_url, url_key)


class TierTests(unittest.TestCase):
    def test_default_tier_mapping(self):
        cases = {
            "https://www.canada.ca/en/department-national-defence.html": "official",
            "https://www.tps.ca/media-centre/news-releases/123/": "official",
            "https://www.siu.on.ca/en/directors_report_details.php?drid=1": "official",
            "https://www.cpso.on.ca/en/News": "official",
            "https://www.toronto.ca/news/": "official",
            "https://www.peelpolice.ca/en/news": "official",
            "https://www.ottawa.ca/en/city-hall": "official",
            "https://www.ontariocourts.ca/decisions": "official",
            "https://www.cbc.ca/news/canada/toronto/story-1.123": "major",
            "https://toronto.citynews.ca/2026/10/09/story": "major",
            "https://www.reuters.com/world/americas/x": "major",
            "https://www.bbc.co.uk/news/world": "major",
            "https://torontosun.com/news/local-news/story": "local",
            "https://www.somesmalltown.ca/story": "local",
            "https://example.com/blog/post": "other",
            "https://www.the1news.com/news/abc": "aggregator",
            "https://www.msn.com/en-ca/news/canada/x": "aggregator",
            "https://ca.news.yahoo.com/story": "aggregator",
            "https://www.newsbreak.com/toronto-on/1": "aggregator",
        }
        for url, tier in cases.items():
            with self.subTest(url=url):
                self.assertEqual(tier_for_url(url), tier)

    def test_preferred_domains_count_as_major_but_never_outrank_official(self):
        self.assertEqual(tier_for_url("https://www.example-outlet.com/a"), "other")
        self.assertEqual(tier_for_url("https://www.example-outlet.com/a", ["example-outlet.com"]), "major")
        self.assertEqual(tier_for_url("https://sub.example-outlet.com/a", ["https://www.Example-Outlet.com/news"]), "major")
        self.assertEqual(tier_for_url("https://www.the1news.com/a", ["the1news.com"]), "major")  # The newsroom chose it.
        self.assertEqual(tier_for_url("https://www.tps.ca/a", ["tps.ca"]), "official")

    def test_source_types_per_tier(self):
        self.assertEqual([source_type_for_tier(t) for t in ("official", "major", "local", "other", "aggregator")],
                         ["official", "news_report", "news_report", "news_report", "aggregator"])

    def test_domain_normalisation_and_official_hints(self):
        self.assertEqual(normalize_domains(["https://www.CBC.ca/news", "*.thestar.com", "not a domain", "cbc.ca"]), ["cbc.ca", "thestar.com"])
        self.assertEqual(normalize_domains("cbc.ca, ctvnews.ca"), ["cbc.ca", "ctvnews.ca"])
        self.assertEqual(official_domains_for_query("SIU investigation Toronto Police officer"), ["tps.ca", "siu.on.ca"])
        self.assertEqual(official_domains_for_query("best pizza in town"), [])


def page(url, published=None, order=None, **extra):
    return {"url": url, "title": url, "text": "x" * 300, "publishedAt": published, **({"order": order} if order is not None else {}), **extra}


class RankingTests(unittest.TestCase):
    def test_aggregator_is_dropped_once_three_better_pages_exist(self):
        pages = [page("https://www.the1news.com/a", "2026-10-09T10:00:00Z"), page("https://www.cbc.ca/a", "2026-10-08T10:00:00Z"),
                 page("https://www.ctvnews.ca/a", "2026-10-08T09:00:00Z"), page("https://www.tps.ca/a", "2026-10-07T09:00:00Z")]
        ranked = rank_pages(pages)
        self.assertEqual([p["tier"] for p in ranked], ["official", "major", "major"])
        self.assertNotIn("the1news.com", json.dumps(ranked))

    def test_aggregator_is_kept_last_when_support_is_thin(self):
        ranked = rank_pages([page("https://www.the1news.com/a", "2026-10-09T10:00:00Z"), page("https://www.cbc.ca/a", "2026-10-01T10:00:00Z")])
        self.assertEqual([p["tier"] for p in ranked], ["major", "aggregator"])

    def test_order_is_tier_then_recency_then_query_order_with_unknown_dates_last(self):
        ranked = rank_pages([
            page("https://www.cbc.ca/old", "2026-09-01T00:00:00Z", 0),
            page("https://www.ctvnews.ca/undated", None, 1),
            page("https://www.globalnews.ca/new", "2026-10-09T00:00:00Z", 2),
            page("https://www.thestar.com/tie-b", "2026-10-09T00:00:00Z", 4),
            page("https://www.nationalpost.com/tie-a", "2026-10-09T00:00:00Z", 3),
            page("https://www.toronto.ca/a", "2020-01-01T00:00:00Z", 5)])
        self.assertEqual([p["url"].split("/")[-1] for p in ranked], ["a", "new", "tie-a", "tie-b", "old", "undated"])

    def test_duplicates_collapse_across_tracking_params_and_limit_applies(self):
        ranked = rank_pages([page("https://www.cbc.ca/a?utm_source=x", "2026-10-09T00:00:00Z", 0), page("https://cbc.ca/a/#top", None, 1),
                             *[page(f"https://example.com/{n}", None, n + 2) for n in range(10)]], limit=8)
        self.assertEqual(len(ranked), 8)
        self.assertEqual(sum(url_key(p["url"]) == "cbc.ca/a" for p in ranked), 1)


class ExaRequestTests(unittest.IsolatedAsyncioTestCase):
    def test_body_carries_domains_and_date_filter(self):
        body = exa_body("tps news release", results=6, since="2026-10-01T00:00:00Z", max_characters=3500, include_domains=["tps.ca", "siu.on.ca"])
        self.assertEqual(body["includeDomains"], ["tps.ca", "siu.on.ca"])
        self.assertEqual(body["startPublishedDate"], "2026-10-01T00:00:00Z")
        self.assertEqual(body["numResults"], 6)
        self.assertEqual(body["contents"], {"text": {"maxCharacters": 3500}})
        plain = exa_body("q")
        self.assertNotIn("includeDomains", plain)
        self.assertNotIn("startPublishedDate", plain)

    async def test_include_domains_is_forwarded_on_the_wire(self):
        seen = []

        def respond(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"results": [
                {"url": "https://www.tps.ca/a", "title": "Release", "text": "t" * 250, "publishedDate": "2026-10-09T00:00:00Z"},
                {"url": "https://www.tps.ca/short", "title": "Short", "text": "tiny"}]})

        pages = await exa_pages("key", "tps release", since="2026-10-01T00:00:00Z", include_domains=["tps.ca"],
                                transport=httpx.MockTransport(respond))
        self.assertEqual(seen[0]["includeDomains"], ["tps.ca"])
        self.assertEqual(seen[0]["startPublishedDate"], "2026-10-01T00:00:00Z")
        self.assertEqual([p["url"] for p in pages], ["https://www.tps.ca/a"])
        self.assertEqual(pages[0]["publishedAt"], "2026-10-09T00:00:00Z")


class PlanParsingTests(unittest.TestCase):
    NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)

    def test_parse_tolerates_fences_and_clamps_fields(self):
        text = ('Sure!\n```json\n{"mode": "research", "assumption": "the OTT show as your Ottawa program.", "queries": ['
                '{"q": "  SIU  Toronto soldier charges ", "intent": "official", "days": 14, "domains": ["https://www.siu.on.ca/x", "junk"]},'
                '{"q": "siu toronto soldier charges"}, {"q": "x"}, {"q": "second", "intent": "weird", "days": -3},'
                '{"q": "third"}, {"q": "fourth"}, {"q": "fifth"}]}\n```')
        plan = research_plan.parse_plan(text)
        self.assertEqual(plan["mode"], "research")
        self.assertEqual(plan["assumption"], "the OTT show as your Ottawa program")
        self.assertEqual([q["q"] for q in plan["queries"]], ["SIU Toronto soldier charges", "second", "third", "fourth"])
        self.assertEqual(plan["queries"][0], {"q": "SIU Toronto soldier charges", "intent": "official", "days": 14, "domains": ["siu.on.ca"]})
        self.assertEqual(plan["queries"][1]["intent"], "news")
        self.assertIsNone(plan["queries"][1]["days"])

    def test_garbage_and_empty_research_are_unusable(self):
        for text in ("no json here", "{broken", "[1, 2]", '{"mode": "research", "queries": []}', None):
            with self.subTest(text=text):
                self.assertIsNone(research_plan.parse_plan(text))

    def test_requirement_flag_overrides_the_planner(self):
        thread = research_plan.parse_plan('{"mode": "thread", "assumption": "", "queries": []}')
        self.assertEqual(research_plan.apply_requirement(thread, False, "s", self.NOW)["mode"], "thread")
        forced = research_plan.apply_requirement(thread, True, "Ottawa budget", self.NOW)
        self.assertEqual([q["q"] for q in forced["queries"]], ["Ottawa budget", "Ottawa budget October 2026"])
        self.assertEqual(research_plan.apply_requirement(None, None, "Ottawa budget", self.NOW)["mode"], "research")
        self.assertEqual(research_plan.apply_requirement(thread, None, "s", self.NOW)["mode"], "thread")

    def test_newsroom_context_parsing(self):
        parsed = research_plan.parse_newsroom_context(json.dumps(
            {"timezone": "America/Toronto", "homeMarket": " Toronto ", "preferredDomains": ["https://www.cp24.com/x", "bad"], "today": "Saturday, October 10, 2026"}))
        self.assertEqual(parsed, {"timezone": "America/Toronto", "homeMarket": "Toronto", "preferredDomains": ["cp24.com"], "today": "Saturday, October 10, 2026"})
        self.assertEqual(research_plan.parse_newsroom_context("not json"), {})
        self.assertEqual(research_plan.parse_newsroom_context(None), {})
