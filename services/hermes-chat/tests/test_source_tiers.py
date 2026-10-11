from __future__ import annotations
import json
import unittest
from datetime import datetime, timezone

import httpx

from hermes_chat import research_plan
from hermes_chat.search_adapters import exa_body, exa_pages
from hermes_chat.source_tiers import (is_non_content_page, is_non_content_url, key_terms, looks_like_listing, normalize_domains,
                                      official_domains_for_query, on_topic, outlet_for_query, place_tokens, rank_pages,
                                      source_type_for_tier, tier_for_url, topic_hits, url_key)


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
        self.assertEqual([p["tier"] for p in ranked], ["major", "major", "official"])  # Query order, not tier order.
        self.assertNotIn("the1news.com", json.dumps(ranked))

    def test_aggregator_is_kept_when_support_is_thin_and_keeps_its_relevance_place(self):
        ranked = rank_pages([page("https://www.the1news.com/a", "2026-10-09T10:00:00Z"), page("https://www.cbc.ca/a", "2026-10-01T10:00:00Z")])
        self.assertEqual([p["tier"] for p in ranked], ["aggregator", "major"])

    def test_round_robin_across_queries_then_tier_breaks_ties_within_a_query_rank(self):
        def q(query, position, url):
            return page(url, None, query * 10 + position, query=query, position=position)
        ranked = rank_pages([
            q(0, 0, "https://www.cbc.ca/q0-first"), q(0, 1, "https://www.ctvnews.ca/q0-second"), q(0, 2, "https://www.cp24.com/q0-third"),
            q(1, 0, "https://www.tps.ca/q1-first"), q(1, 1, "https://www.siu.on.ca/q1-second"),
            q(2, 0, "https://news.ontario.ca/q2-first")], guaranteed_query=None)
        self.assertEqual([p["url"].split("/")[-1] for p in ranked],
                         ["q0-first", "q1-first", "q2-first", "q0-second", "q1-second", "q0-third"])
        # Official pages never jump ahead of an earlier query's top result.
        self.assertEqual(ranked[0]["tier"], "major")

    def test_first_query_keeps_its_top_three_pages_in_the_final_cut(self):
        pages = [page(f"https://example{q}.com/{p}", None, q * 10 + p, query=q, position=p) for q in range(4) for p in range(3)]
        ranked = rank_pages(pages, limit=8, guaranteed_query=0)
        self.assertEqual({p["url"] for p in ranked if p["query"] == 0}, {f"https://example0.com/{p}" for p in range(3)})
        self.assertEqual(len(ranked), 8)
        plain = rank_pages(pages, limit=8, guaranteed_query=None)
        self.assertEqual(sum(p["query"] == 0 for p in plain), 2)

    def test_pages_naming_none_of_the_places_sort_after_those_that_do(self):
        def local(url, query, position, text="Toronto police said the crash closed the Gardiner."):
            return {"url": url, "title": "Report " + url[-1], "text": text * 3, "query": query, "position": position}
        alberta = "Environment Canada issued a snowfall warning for Calgary and Edmonton, Alberta."
        pages = [local("https://weather.gc.ca/warnings/a", 0, 0, alberta), local("https://www.cbc.ca/news/b", 1, 0),
                 local("https://www.ctvnews.ca/c", 2, 0, "Ontario police continue to investigate the Etobicoke shooting."), local("https://www.cp24.com/d", 1, 1)]
        ranked = rank_pages(pages, places=["toronto", "gta", "ontario"], guaranteed_query=None, allow_weather=True)
        self.assertEqual([p["url"][-1] for p in ranked], ["b", "c", "d", "a"])
        self.assertEqual([p["url"][-1] for p in rank_pages(pages, places=["toronto"], guaranteed_query=None, allow_weather=True, limit=2)], ["b", "d"])
        # Nothing names the place: no demotion, relevance order stands.
        elsewhere = [local("https://a.example.com/x", 0, 0, alberta), local("https://b.example.com/y", 1, 0, alberta)]
        self.assertEqual([p["url"][-1] for p in rank_pages(elsewhere, places=["toronto"], guaranteed_query=None)], ["x", "y"])

    def test_pages_sharing_no_key_entity_with_the_request_are_demoted(self):
        def doc(url, text, query=0, position=0):
            return {"url": url, "title": text[:30], "text": text * 3, "query": query, "position": position}
        terms = key_terms("Go with the soldier story as our lead - the three 7th Toronto Regiment reservists charged in the July kidnapping.")
        pages = [doc("https://www.tps.ca/online-reporting/x", "Report a lost item or a minor theft online with Toronto Police."),
                 doc("https://www.canlii.org/en/on/onsc/2023/y", "A firearms ruling about an unrelated 2023 sentencing."),
                 doc("https://www.nationalpost.com/news/z", "Three reservists of the 7th Toronto Regiment face kidnapping charges, police said.", 1, 0)]
        ranked = rank_pages(pages, terms=terms, guaranteed_query=None)
        self.assertEqual(ranked[0]["url"], "https://www.nationalpost.com/news/z")
        self.assertEqual(len(rank_pages(pages, terms=terms, guaranteed_query=None, limit=1)), 1)

    def test_outlet_query_keeps_only_that_outlet_and_may_end_up_empty(self):
        pages = [{"url": "https://obituaries.thestar.com/obituary/a", "title": "Obit", "text": "x" * 300, "query": 0, "position": 0},
                 {"url": "https://www.cbc.ca/news/safer-supply", "title": "CBC story", "text": "x" * 300, "query": 0, "position": 1},
                 {"url": "https://www.cbc.ca/news/other", "title": "CBC other", "text": "x" * 300, "query": 1, "position": 0}]
        ranked = rank_pages(pages, outlets={0: ["thestar.com"]}, guaranteed_query=None)
        self.assertEqual([p["url"] for p in ranked], ["https://www.cbc.ca/news/other"])

    def test_duplicates_collapse_across_tracking_params_and_limit_applies(self):
        ranked = rank_pages([page("https://www.cbc.ca/a?utm_source=x", "2026-10-09T00:00:00Z", 0), page("https://cbc.ca/a/#top", None, 1),
                             *[page(f"https://example.com/{n}", None, n + 2) for n in range(10)]], limit=8)
        self.assertEqual(len(ranked), 8)
        self.assertEqual(sum(url_key(p["url"]) == "cbc.ca/a" for p in ranked), 1)


class NonContentTests(unittest.TestCase):
    LIVE_NON_CONTENT = (
        "https://news.ontario.ca/search/en", "https://news.ontario.ca/MTIFDC/fr", "https://api.news.ontario.ca/api/v1/releases",
        "https://obituaries.thestar.com/obituary/john-smith", "https://obituaries.thestar.com/", "https://obituaries.thestar.com/obituaries/jane-doe",
        "https://obituaries.thestar.com/obituary/a-b-c-1", "https://www.tps.ca/", "https://www.ontario.ca/fr", "https://www.ontario.ca/en",
        "https://www.cbc.ca/search?q=toronto", "https://www.ctvnews.ca/?s=toronto", "https://www.thestar.com/feed", "https://www.cbc.ca/cmlink/rss-topstories",
        "https://www.thestar.com/tag/crime", "https://www.thestar.com/tags/crime/", "https://www.thestar.com/category/news/", "https://www.thestar.com/author/jo",
        "https://www.thestar.com/obituaries/", "https://classifieds.thestar.com/ad/1", "https://jobs.example.com/x", "https://careers.cbc.ca/x",
        "https://shop.cbc.ca/x", "https://events.thestar.com/x", "https://weather.gc.ca/warnings/report_e.html?ab6",
        "https://www.thestar.com/classifieds/x", "https://www.thestar.com/jobs/x", "https://www.thestar.com/careers", "https://www.thestar.com/sitemap.xml",
        "https://www.thestar.com/newsletters", "https://www.thestar.com/subscribe", "https://www.thestar.com/account/settings",
        "https://www.thestar.com/login", "https://www.thestar.com/privacy", "https://www.thestar.com/terms",
    )
    LIVE_CONTENT = (
        "https://www.cbc.ca/news/canada/toronto/fatal-collisions-2026-1.7000000", "https://www.ctvnews.ca/toronto/article/2026/10/10/siu-clears-officer/",
        "https://www.ctvnews.ca/toronto/article/2026/10/10/gunfire-etobicoke/", "https://www.thecanadavoice.ca/news/toronto-gta-update",
        "https://www.narcity.com/toronto/things-to-do", "https://www.thestar.com/news/gta/safer-supply-cpso.html", "https://news.ontario.ca/en/release/1006700/ontario-supports-x",
        "https://www.cbc.ca/news/business/jobs-report-1.123", "https://ero.ontario.ca/notice/013-9000",
    )

    def test_index_search_api_feed_listing_and_non_news_urls_are_dropped(self):
        for url in self.LIVE_NON_CONTENT:
            with self.subTest(url=url):
                self.assertTrue(is_non_content_url(url), url)

    def test_real_article_urls_are_kept(self):
        for url in self.LIVE_CONTENT:
            with self.subTest(url=url):
                self.assertFalse(is_non_content_url(url), url)

    def test_weather_hosts_are_kept_only_for_weather_requests(self):
        url = "https://weather.gc.ca/warnings/report_e.html?on40"
        self.assertTrue(is_non_content_url(url))
        self.assertFalse(is_non_content_url(url, allow_weather=True))

    def test_listing_text_and_site_name_titles(self):
        listing = "\n".join(f"Release number {n}" for n in range(30))
        self.assertTrue(looks_like_listing(listing))
        prose = "\n".join(["Police said a man was arrested on Friday after a lengthy investigation that began in the summer and involved several agencies working together."] * 3)
        self.assertFalse(looks_like_listing(prose))
        self.assertFalse(looks_like_listing("\n".join(f"Short line {n}" for n in range(3))))
        self.assertTrue(looks_like_listing("anything", "Ontario Newsroom", "https://news.ontario.ca/en/release/1"))
        self.assertTrue(looks_like_listing("anything", "CBC News", "https://www.cbc.ca/news/x"))
        self.assertFalse(looks_like_listing("anything", "SIU clears officer in shooting", "https://www.cbc.ca/news/x"))
        self.assertTrue(is_non_content_page({"url": "https://example.com/news/abc", "title": "Example", "text": listing}))
        self.assertFalse(is_non_content_page({"url": "https://example.com/news/abc", "title": "SIU decision", "text": prose}))


class RelevanceTermTests(unittest.TestCase):
    def test_place_tokens_expand_the_gta_family_and_unlisted_markets(self):
        self.assertEqual(place_tokens("anything new?", "Toronto"), ["toronto", "gta", "greater toronto", "ontario"])
        self.assertIn("mississauga", place_tokens("Mississauga transit strike"))
        self.assertIn("ontario", place_tokens("Mississauga transit strike"))
        self.assertEqual(place_tokens("news", "Calgary"), ["calgary"])
        self.assertEqual(place_tokens("what happened", ""), [])

    def test_key_terms_pick_entities_and_skip_places_and_filler(self):
        terms = key_terms("Go with the soldier story as our lead - the three 7th Toronto Regiment reservists charged in the July kidnapping. "
                          "Full timeline since July: what Toronto Police and DND have confirmed vs what's alleged. Primary sources only.")
        self.assertEqual(terms, ["7th", "regiment", "reservists", "kidnapping", "dnd"])
        self.assertTrue(on_topic(3, terms))
        self.assertFalse(on_topic(2, terms))
        self.assertTrue(on_topic(1, ["kidnapping"]))
        self.assertFalse(on_topic(0, []))
        self.assertEqual(topic_hits({"title": "", "text": "A 7th Regiment kidnapping case"}, terms), 3)

    def test_outlets_named_in_a_query(self):
        self.assertEqual(outlet_for_query("Toronto Star safer supply CPSO proposal"), ("Toronto Star", ["thestar.com"]))
        self.assertEqual(outlet_for_query("Toronto soldiers charged CBC")[1], ["cbc.ca"])
        self.assertIsNone(outlet_for_query("Toronto Police news release"))
        self.assertIsNone(outlet_for_query("global warming report"))


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


class PlannerPromptTests(unittest.TestCase):
    NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)

    def prompt(self, request, market="Toronto"):
        return research_plan.planner_prompt(request=request, newsroom={"homeMarket": market}, now=self.NOW, dialogue="(none)", sources={}, required=None)

    def test_rules_name_body_place_event_news_query_and_weather_city(self):
        rules = research_plan.PLANNER_RULES
        self.assertIn("name the body, the place and the event", rules)
        self.assertIn("never \"GTA weather\" alone", rules)
        self.assertIn("one plain news query", rules)
        self.assertIn("never means leave news coverage out", rules)
        self.assertIn("never restate the request", rules)

    def test_rundown_requests_get_multi_beat_guidance_with_at_most_four_queries(self):
        for request in ("anything new for the OTT show?", "What should I consider for tonight's newscast", "build me a rundown", "what's new in Toronto"):
            with self.subTest(request=request):
                prompt = self.prompt(request)
                self.assertIn("rundown-style scan of Toronto", prompt)
                self.assertIn("Toronto news top stories today", prompt)
                self.assertIn("city hall, transit, police, courts", prompt)
                self.assertIn("at most 4 queries", prompt)
        for request in ("Show me the court documents", "who is the SIU director"):
            with self.subTest(request=request):
                self.assertNotIn("rundown-style", self.prompt(request))
        self.assertIn("rundown-style scan of the home market", self.prompt("anything new?", market="not set"))

    def test_a_plain_news_query_is_always_present_and_first(self):
        official = [{"q": "Toronto Police news release kidnapping", "intent": "official", "days": None, "domains": []},
                    {"q": "DND statement reservists", "intent": "official", "days": None, "domains": ["canada.ca"]}]
        queries = research_plan.ensure_news_query(official, "Toronto reservists kidnapping case", "Toronto")
        self.assertEqual([q["intent"] for q in queries], ["news", "official", "official"])
        self.assertEqual(queries[0], {"q": "Toronto reservists kidnapping case", "intent": "news", "days": 14, "domains": []})
        full = [{"q": f"q{n}", "intent": "official", "days": None, "domains": []} for n in range(4)]
        self.assertEqual(len(research_plan.ensure_news_query(full, "subject words", "")), 4)
        with_news = [{"q": "a news", "intent": "news", "days": 3, "domains": []}]
        self.assertIs(research_plan.ensure_news_query(with_news, "subject", ""), with_news)
        restricted_only = [{"q": "a", "intent": "news", "days": 3, "domains": ["cbc.ca"]}]
        self.assertEqual(research_plan.ensure_news_query(restricted_only, "subject here", "")[0]["domains"], [])

    def test_assumption_that_restates_the_request_is_suppressed_but_real_ambiguity_survives(self):
        request = ("Go with the soldier story as our lead - the three 7th Toronto Regiment reservists charged in the July kidnapping. "
                   "Full timeline since July; what Toronto Police and DND have confirmed, charges per accused, court status.")
        plan = {"mode": "research", "assumption": "the July kidnapping as a Toronto case, three accused named",
                "queries": [{"q": "reservists kidnapping Toronto", "intent": "news", "days": 14, "domains": []}], "source": "planner"}
        self.assertEqual(research_plan.apply_requirement(plan, None, "soldier story", self.NOW, request=request)["assumption"], "")
        cpso = {**plan, "assumption": "CPSO safer supply proposal as the Ontario regulator's new prescribing guidance"}
        self.assertEqual(research_plan.apply_requirement(
            cpso, None, "CPSO safer supply", self.NOW, request="Toronto Star safer supply CPSO proposal: what changed?")["assumption"], "")
        ambiguous = {**plan, "assumption": "'the OTT show' as your Ottawa program"}
        self.assertEqual(research_plan.apply_requirement(ambiguous, None, "ott", self.NOW, request="anything new for the OTT show this week?")["assumption"],
                         "'the OTT show' as your Ottawa program")
