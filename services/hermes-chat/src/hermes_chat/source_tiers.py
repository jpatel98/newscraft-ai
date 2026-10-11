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


def rank_pages(pages: Sequence[dict[str, Any]], preferred_domains: Sequence[str] = (), *, limit: int = 8,
               aggregator_floor: int = 3) -> list[dict[str, Any]]:
    """Tier, then newest, then query order. Each page needs 'url'; 'publishedAt' and 'order' are optional.

    Returns copies with a 'tier' key, de-duplicated by URL, with aggregator pages dropped once
    ``aggregator_floor`` pages of any better tier exist, truncated to ``limit``.
    """
    seen: set[str] = set()
    tiered: list[dict[str, Any]] = []
    for index, page in enumerate(pages):
        key = url_key(page["url"])
        if key in seen:
            continue
        seen.add(key)
        tiered.append({**page, "tier": tier_for_url(page["url"], preferred_domains), "order": page.get("order", index)})
    better = sum(page["tier"] != "aggregator" for page in tiered)
    if better >= aggregator_floor:
        tiered = [page for page in tiered if page["tier"] != "aggregator"]

    def key(page: dict[str, Any]):
        moment = published_timestamp(page.get("publishedAt"))
        return (TIER_RANK[page["tier"]], 0 if moment is not None else 1, -(moment or 0.0), page["order"])

    return sorted(tiered, key=key)[:limit]
