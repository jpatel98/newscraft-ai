"""Source tiers for planned research: who is trusted first, and who is dropped.

The default lists are Canadian/GTA flavoured and are plain module constants so a
tenant-supplied list can replace them later. Tiers rank pages; they never turn a
page into evidence. Evidence still comes from the page text itself.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence
from urllib.parse import parse_qsl, urlencode, urlsplit

TIERS = ("official", "major", "local", "other", "aggregator")
TIER_RANK = {name: index for index, name in enumerate(TIERS)}
# Citation sourceType per tier. "aggregator" is a first-class type so the UI can warn about it.
SOURCE_TYPE_FOR_TIER = {"official": "official", "major": "news_report", "local": "news_report",
                        "other": "news_report", "aggregator": "aggregator"}

OFFICIAL_SUFFIXES = (".gc.ca", ".gov", ".gouv.qc.ca", ".gov.on.ca", ".on.ca", ".gov.uk", ".gov.au", ".gov.bc.ca", ".gov.ab.ca", ".mil")
OFFICIAL_DOMAINS = (
    "canada.ca", "ontario.ca", "toronto.ca", "tps.ca", "ttc.ca", "metrolinx.com", "gotransit.com", "cpso.on.ca", "siu.on.ca",
    "opp.ca", "rcmp-grc.gc.ca", "yrp.ca", "peelpolice.ca", "haltonpolice.ca", "durhampolice.ca", "hamiltonpolice.on.ca",
    "ontariocourts.ca", "scc-csc.ca", "courts.ca", "canlii.org", "elections.ca", "elections.on.ca", "parl.ca", "ola.org",
    "ottawa.ca", "mississauga.ca", "brampton.ca", "markham.ca", "vaughan.ca", "hamilton.ca", "burlington.ca", "oakville.ca",
    "richmondhill.ca", "pickering.ca", "ajax.ca", "oshawa.ca", "whitby.ca", "durham.ca", "peelregion.ca", "halton.ca", "york.ca",
    "statcan.gc.ca", "bankofcanada.ca", "pearsonairport.com", "who.int", "un.org", "europa.eu",
)
MAJOR_DOMAINS = (
    "cbc.ca", "radio-canada.ca", "ctvnews.ca", "globalnews.ca", "thestar.com", "theglobeandmail.com", "nationalpost.com",
    "cp24.com", "citynews.ca", "thecanadianpress.com", "financialpost.com", "tvo.org", "macleans.ca",
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "nytimes.com", "washingtonpost.com", "bloomberg.com",
    "theguardian.com", "npr.org",
)
LOCAL_DOMAINS = (
    "torontosun.com", "blogto.com", "urbantoronto.ca", "insauga.com", "durhamregion.com", "yorkregion.com",
    "insidehalton.com", "thespec.com", "lfpress.com", "ottawacitizen.com", "montrealgazette.com", "vancouversun.com",
    "torontolife.com", "nowtoronto.com",
)
AGGREGATOR_DOMAINS = (
    "the1news.com", "newsbreak.com", "ground.news", "msn.com", "news.yahoo.com", "ca.news.yahoo.com", "flipboard.com",
    "headtopics.com", "newsnow.co.uk", "newsnow.com", "feedly.com", "inkl.com", "pressreader.com",
)
# Entity words in a query that name an official publisher. Used to aim an "official" query at the source itself.
OFFICIAL_HINTS = (
    (r"toronto police|\btps\b", ("tps.ca",)),
    (r"\bsiu\b|special investigations unit", ("siu.on.ca",)),
    (r"\bcpso\b|college of physicians and surgeons of ontario", ("cpso.on.ca",)),
    (r"\bttc\b|toronto transit commission", ("ttc.ca",)),
    (r"metrolinx|go transit|ontario line", ("metrolinx.com",)),
    (r"city of toronto|toronto city council|toronto council", ("toronto.ca",)),
    (r"\bdnd\b|department of national defence|canadian armed forces|national defence|canadian forces", ("canada.ca",)),
    (r"\brcmp\b", ("rcmp-grc.gc.ca",)),
    (r"\bopp\b|ontario provincial police", ("opp.ca",)),
    (r"peel regional police|peel police", ("peelpolice.ca",)),
    (r"york regional police", ("yrp.ca",)),
    (r"government of ontario|ontario government|ontario legislature|queen's park|province of ontario", ("ontario.ca", "news.ontario.ca")),
    (r"government of canada|federal government|health canada|transport canada|ircc|\bcra\b|statistics canada", ("canada.ca",)),
)

_TRACKING = re.compile(r"^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|taid)$", re.I)
_DOMAIN = re.compile(r"^(?=.{4,100}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$")
_POLICE = re.compile(r"[a-z0-9-]*police(?:services?)?")
_COURTS = re.compile(r"[a-z0-9-]*courts?")


def host_of(url: str) -> str:
    try:
        host = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def normalize_domain(value: Any) -> str | None:
    """A bare hostname from a domain, URL or '*.domain' string, else None."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    text = re.sub(r"^[a-z][a-z0-9+.-]*://", "", text).lstrip("*.").split("/", 1)[0].split("?", 1)[0].split(":", 1)[0].strip(".")
    text = text[4:] if text.startswith("www.") else text
    return text if _DOMAIN.fullmatch(text) else None


def normalize_domains(values: Any, limit: int = 10) -> list[str]:
    if isinstance(values, str):
        values = re.split(r"[,\s;]+", values)
    if not isinstance(values, (list, tuple)):
        return []
    result: list[str] = []
    for value in values:
        domain = normalize_domain(value)
        if domain and domain not in result:
            result.append(domain)
    return result[:limit]


def _within(host: str, domains: Iterable[str]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def _second_level(host: str) -> str:
    labels = host.split(".")
    if len(labels) >= 3 and labels[-2] in {"co", "com", "on", "gc", "gov", "org", "qc", "bc", "ab"}:
        return labels[-3]
    return labels[-2] if len(labels) >= 2 else host


def tier_for_url(url: str, preferred_domains: Sequence[str] = ()) -> str:
    """official | major | local | other | aggregator for a page URL."""
    host = host_of(url)
    if not host:
        return "other"
    if _within(host, OFFICIAL_DOMAINS) or any(host.endswith(suffix) for suffix in OFFICIAL_SUFFIXES):
        return "official"
    sld = _second_level(host)
    if _POLICE.fullmatch(sld) or _COURTS.fullmatch(sld):
        return "official"
    if _within(host, normalize_domains(list(preferred_domains), limit=50)):
        return "major"
    if _within(host, AGGREGATOR_DOMAINS):
        return "aggregator"
    if _within(host, MAJOR_DOMAINS):
        return "major"
    if _within(host, LOCAL_DOMAINS) or host.endswith(".ca"):
        return "local"
    return "other"


def source_type_for_tier(tier: str) -> str:
    return SOURCE_TYPE_FOR_TIER.get(tier, "news_report")


def official_domains_for_query(query: str) -> list[str]:
    """Official publishers named in a query ('SIU', 'Toronto Police'), in a stable order."""
    found: list[str] = []
    for pattern, domains in OFFICIAL_HINTS:
        if re.search(pattern, query, re.I):
            found.extend(domain for domain in domains if domain not in found)
    return found[:4]


def url_key(url: str) -> str:
    """Identity for de-duplication: host + path + non-tracking query, without scheme or fragment."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query) if not _TRACKING.match(k)))
    return f"{host_of(url)}{parts.path.rstrip('/')}" + (f"?{query}" if query else "")


def published_timestamp(value: Any) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        try:
            moment = datetime.strptime(text[:10], "%Y-%m-%d")
        except ValueError:
            return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


# ---- Pages that are not content: indexes, search, APIs, feeds, language roots ----------------------------------
_NON_CONTENT_PATH = re.compile(
    r"(?:^|/)(?:search|search-results?|api|tags?|categor(?:y|ies)|authors?)(?:/|$)|(?:^|/)(?:feeds?|rss|atom)(?:[-_./]|$)|\.(?:xml|rss|atom|json)$", re.I)
_LANGUAGE_ROOT = re.compile(r"(?:^|/)(?:en|fr)(?:-[a-z]{2})?(?:/index(?:\.\w+)?)?/?$", re.I)
_NON_NEWS_HOSTS = ("obituaries.", "obits.", "obituary.", "classifieds.", "jobs.", "careers.", "shop.", "store.", "events.")
_NON_NEWS_PATH = re.compile(
    r"(?:^|/)(?:obituary|obituaries|classifieds|jobs|careers|sitemap\w*|newsletters?|subscribe|account|login|privacy|terms)(?:/|\.|$)", re.I)
WEATHER_REQUEST = re.compile(r"\b(?:weather|forecast|warnings?|storms?|snow(?:fall)?|rain(?:fall)?|heat|tornado|blizzard|flood(?:ing)?|freezing)\b", re.I)
_SEARCH_PARAMS = frozenset({"q", "s", "query", "search", "keyword", "keywords"})
_SITE_SUFFIXES = ("", "news", "newsroom", "home", "homepage", "online", "ca")


def is_non_content_url(url: str, allow_weather: bool = False) -> bool:
    """A search, listing, API, feed, root or non-news (obituary, classifieds, jobs, account) URL: never evidence."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return True
    host, path = host_of(url), parts.path or "/"
    if host.startswith("api.") or ".api." in host or host.startswith(_NON_NEWS_HOSTS):
        return True
    if host.startswith("weather.") and not allow_weather:
        return True
    if _NON_NEWS_PATH.search(path):
        return True
    if path in {"", "/"} and not any(k.lower() not in _SEARCH_PARAMS and v for k, v in parse_qsl(parts.query)):
        return True  # A bare host root (a query string of only search terms is dropped below as well).
    if _NON_CONTENT_PATH.search(path) or _LANGUAGE_ROOT.search(path):
        return True
    return any(key.lower() in _SEARCH_PARAMS for key, _ in parse_qsl(parts.query, keep_blank_values=True))


def _squash(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def title_is_site_name(title: str, url: str) -> bool:
    host = host_of(url)
    name = _squash(title)
    if not name or not host:
        return False
    labels = [label for label in host.split(".") if label]
    bare = _second_level(host)
    forms = {_squash(host), bare, _squash(".".join(labels[:-1])) if len(labels) > 1 else bare}
    forms |= {bare + suffix for suffix in _SITE_SUFFIXES}
    return name in forms


def looks_like_listing(text: str, title: str = "", url: str = "") -> bool:
    """Index-like text: many short lines and no real sentence, or a title that is just the site name."""
    if title and url and title_is_site_name(title, url):
        return True
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    if len(lines) < 8:
        return False
    segments = [part for line in lines for part in re.split(r"(?<=[.!?])\s+", line) if part]
    if max(map(len, segments), default=0) > 120:
        return False
    return sorted(map(len, lines))[len(lines) // 2] < 60


def is_non_content_page(page: dict[str, Any], allow_weather: bool = False) -> bool:
    return is_non_content_url(page["url"], allow_weather) or looks_like_listing(page.get("text") or "", page.get("title") or "", page["url"])


# ---- Outlets named in a query -----------------------------------------------------------------------------------
OUTLET_NAMES = (
    (r"toronto star|thestar|\bthe star\b", ("thestar.com",)), (r"\bcbc\b", ("cbc.ca",)), (r"\bctv\b", ("ctvnews.ca",)),
    (r"global news", ("globalnews.ca",)), (r"globe and mail|globe & mail", ("theglobeandmail.com",)),
    (r"national post", ("nationalpost.com",)), (r"\bcp24\b", ("cp24.com",)), (r"citynews", ("citynews.ca",)),
    (r"toronto sun", ("torontosun.com",)), (r"canadian press", ("thecanadianpress.com",)), (r"\bblogto\b", ("blogto.com",)),
)


def outlet_for_query(query: str) -> tuple[str, list[str]] | None:
    """(outlet label, its domains) when a query names a news outlet, else None."""
    for pattern, domains in OUTLET_NAMES:
        match = re.search(pattern, query, re.I)
        if match:
            return match.group(0).strip().title(), list(domains)
    return None


# ---- Key entities of the request ---------------------------------------------------------------------------------
_TERM_STOP = frozenset({
    "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "police", "service", "services", "court", "courts",
    "government", "canada", "canadian", "national", "regional", "news", "ministry", "department", "province", "provincial", "public",
    "official", "officials", "primary", "sources", "source", "timeline", "confirmed", "alleged", "anything", "consider", "competitors",
    "information", "rundown", "newscast", "story", "lead", "full", "since", "what", "which", "with", "from", "that", "this", "have",
    "the", "and", "for", "our", "per", "only", "show", "today", "week", "tonight", "also", "please", "write", "tell", "give", "need",
})

def key_terms(*texts: str, limit: int = 12) -> list[str]:
    """Distinctive entity words in a request: proper nouns, acronyms, ordinals and long lowercase nouns.

    Place names are left to ``place_tokens``; generic newsroom words are stop-listed.
    """
    terms: list[str] = []
    places = {word for token in place_tokens(" ".join(texts)) for word in token.split()}
    for text in texts:
        for sentence in re.split(r"(?<=[.!?:])\s+|\n+", text or ""):
            for index, word in enumerate(re.findall(r"[A-Za-z0-9][A-Za-z0-9'-]*", sentence)):
                word = word.strip("'-")
                low = word.lower()
                if len(word) < 3 or low in _TERM_STOP or low in places or low in terms:
                    continue
                ordinal = bool(re.fullmatch(r"\d+(?:st|nd|rd|th)", low))
                acronym = word.isupper() and len(word) >= 3
                proper = word[0].isupper() and index > 0
                long_lower = word.islower() and len(word) >= 8
                if ordinal or acronym or proper or long_lower:
                    terms.append(low)
    return terms[:limit]


def topic_hits(page: dict[str, Any], terms: Sequence[str]) -> int:
    haystack = f"{page.get('title') or ''}\n{page.get('text') or ''}".lower()
    return sum(bool(re.search(rf"(?<![a-z0-9]){re.escape(term)}", haystack)) for term in terms)


def on_topic(hits: int, terms: Sequence[str]) -> bool:
    """A page is on topic when it shares most of a short term list, or three of a long one."""
    return bool(terms) and hits >= min(3, len(terms))


# ---- Place relevance ---------------------------------------------------------------------------------------------
GTA_PLACES = (
    "Toronto", "Mississauga", "Brampton", "Markham", "Vaughan", "Oakville", "Burlington", "Pickering", "Ajax", "Oshawa", "Whitby",
    "Richmond Hill", "Etobicoke", "Scarborough", "North York", "York Region", "Peel", "Durham", "Halton", "Milton", "Newmarket",
    "Aurora", "Caledon", "Hamilton", "Waterloo", "Kitchener", "Barrie", "Ottawa", "London", "Windsor", "Niagara", "Kingston",
)
_GTA_FAMILY = ("toronto", "gta", "greater toronto", "ontario")
_TORONTO_AREA = frozenset(p.lower() for p in GTA_PLACES if p not in {"Hamilton", "Waterloo", "Kitchener", "Barrie", "Ottawa", "London", "Windsor", "Niagara", "Kingston"})
_PLACE_STOP = frozenset({"canada", "area", "region", "market", "the", "news", "and", "greater", "city", "of", "metro", "local", "home"})


_CASE_SENSITIVE_PLACES = frozenset({"London", "Peel", "Durham", "Aurora", "Halton", "Niagara"})


def place_tokens(request: str, home_market: str = "") -> list[str]:
    """Lower-case place names the request or home market names; Toronto/GTA/Ontario families are expanded."""
    blob = f"{home_market or ''} {request or ''}"
    found: list[str] = []
    for place in (*GTA_PLACES, "GTA", "Ontario"):
        flags = 0 if place in _CASE_SENSITIVE_PLACES or place == "GTA" else re.I
        if re.search(rf"\b{re.escape(place)}\b", blob, flags) and place.lower() not in found:
            found.append(place.lower())
    if "greater toronto" in blob.lower() or any(token == "gta" or token in _TORONTO_AREA for token in found):
        found.extend(token for token in _GTA_FAMILY if token not in found)
    for part in re.split(r"[,/;&]|\band\b", home_market or "", flags=re.I):  # An unlisted home market still counts.
        part = " ".join(word for word in part.split() if word.lower() not in _PLACE_STOP).lower()
        if len(part) >= 3 and part not in found:
            found.append(part)
    return found


def matches_place(page: dict[str, Any], tokens: Sequence[str]) -> bool:
    haystack = f"{page.get('title') or ''}\n{page.get('text') or ''}".lower()
    return any(re.search(rf"\b{re.escape(token)}\b", haystack) for token in tokens)


def rank_pages(pages: Sequence[dict[str, Any]], preferred_domains: Sequence[str] = (), *, limit: int = 8,
               aggregator_floor: int = 3, places: Sequence[str] = (), terms: Sequence[str] = (), allow_weather: bool = False,
               outlets: dict[int, Sequence[str]] | None = None, guaranteed_query: int | None = 0,
               guaranteed_pages: int = 3) -> list[dict[str, Any]]:
    """Relevance first: round-robin across queries, each query in its own (relevance) order.

    A page needs 'url'; 'query' (planner index, default 0) and 'position' (rank within that query,
    default 'order') are optional. Returns copies with a 'tier' key.

    * Index, search, API, listing and non-news (obituary, classifieds, jobs, account) pages are dropped;
      duplicates keep their earliest round.
    * ``outlets`` maps a query index to the domains of the outlet it names: that query keeps only that
      outlet's pages, so an outlet with no coverage leaves its slot empty instead of borrowing others'.
    * Aggregator pages are dropped once ``aggregator_floor`` better pages exist.
    * Tier only breaks ties (same round and query) and labels the page; it never outranks relevance.
    * With ``places`` / ``terms`` (key entities of the request): pages that name none of them sort after
      every page that does, when any page does, and fall off the end first.
    * The top ``guaranteed_pages`` pages of ``guaranteed_query`` always make the cut.
    """
    seen: set[str] = set()
    kept: list[dict[str, Any]] = []
    for index, page in enumerate(pages):
        key = url_key(page["url"])
        if key in seen or is_non_content_page(page, allow_weather):
            continue
        query = page.get("query", 0)
        if outlets and query in outlets and not _within(host_of(page["url"]), outlets[query]):
            continue
        seen.add(key)
        order = page.get("order", index)
        kept.append({**page, "tier": tier_for_url(page["url"], preferred_domains), "order": order,
                     "query": query, "position": page.get("position", order)})
    if sum(page["tier"] != "aggregator" for page in kept) >= aggregator_floor:
        kept = [page for page in kept if page["tier"] != "aggregator"]

    def key(page: dict[str, Any]):
        moment = published_timestamp(page.get("publishedAt"))
        return (page["position"], page["query"], TIER_RANK[page["tier"]], 0 if moment is not None else 1, -(moment or 0.0), page["order"])

    ordered = sorted(kept, key=key)
    near_place = [matches_place(page, places) for page in ordered] if places else []
    near_topic = [topic_hits(page, terms) > 0 for page in ordered] if terms else []
    use_place, use_topic = any(near_place), any(near_topic)
    rank = [(0 if not use_place or near_place[i] else 1, 0 if not use_topic or near_topic[i] else 1) for i in range(len(ordered))]
    indexed = sorted(range(len(ordered)), key=lambda i: (rank[i], i))
    ordered = [ordered[i] for i in indexed]
    eligible = [ordered[n] for n, i in enumerate(indexed) if rank[i] == (0, 0)] if (use_place or use_topic) else ordered
    chosen = ordered[:limit]
    if guaranteed_query is not None:
        must = [page for page in eligible if page["query"] == guaranteed_query][:guaranteed_pages]
        for page in (page for page in must if page not in chosen):
            spare = next((c for c in reversed(chosen) if c not in must), None)
            if spare is None:
                break
            chosen.remove(spare)
            chosen.append(page)
        chosen.sort(key=ordered.index)
    return chosen
