"""Planned research for the fast path: the planner prompt, its JSON, and safe fallbacks.

Everything here is pure (no I/O) so the flow in ``portable.py`` stays small and
the planner contract can be tested directly. Planner output is untrusted model
text: it is parsed defensively and clamped before it can reach a search call.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

from .source_tiers import normalize_domains

PLANNER_MAX_OUTPUT = 400
PLANNER_SECONDS = 12
MAX_QUERIES = 4
MAX_QUERY_CHARS = 200
MAX_ASSUMPTION_CHARS = 120
MAX_DAYS = 3650
INTENTS = ("official", "news", "local", "background")
DEFAULT_TIMEZONE = "America/Toronto"

PLAN_SCHEMA = ('{"mode": "research" | "thread", "assumption": "<12 words or fewer that finish the sentence \\"Taking ...\\", or empty>", '
               '"queries": [{"q": "<search query>", "intent": "official" | "news" | "local" | "background", '
               '"days": <integer or null>, "domains": ["<optional domain>"]}]}')
PLANNER_RULES = (
    "Rules:\n"
    "- Write queries a researcher would type (entity + event + place + time), not the user's sentence.\n"
    "- At most 4 queries. Cover different angles; do not repeat one query with synonyms.\n"
    "- Include at least one query with intent \"official\" when the story involves police, courts, government, regulators, agencies or companies.\n"
    "- Include the home market in the query when the request is local.\n"
    "- \"days\" limits results to the last N days; use it for current news, null otherwise.\n"
    "- Use mode \"thread\" (no queries) when the request is a rewrite or transformation, or the sources already recorded in this conversation answer it. "
    "An explicit instruction such as \"no new research\" or \"use what we have\" means mode \"thread\".\n"
    "- Put a reading in \"assumption\" only when the request is ambiguous and you picked one; otherwise leave it empty.\n"
    "- Reply with the JSON object only, no prose, no code fence."
)


def newsroom_now(timezone_name: str) -> datetime:
    try:
        return datetime.now(ZoneInfo(timezone_name))
    except Exception:  # Unknown zone or missing tz database: UTC is a safe, honest default.
        return datetime.now(timezone.utc)


def parse_newsroom_context(value: Any) -> dict[str, Any]:
    """Normalise the app's Newsroom context into timezone/homeMarket/preferredDomains/today (all optional)."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, Any] = {}
    zone = value.get("timezone")
    if isinstance(zone, str) and 0 < len(zone) <= 64:
        result["timezone"] = zone.strip()
    market = value.get("homeMarket")
    if isinstance(market, str) and market.strip():
        result["homeMarket"] = market.strip()[:120]
    domains = normalize_domains(value.get("preferredDomains"))
    if domains:
        result["preferredDomains"] = domains
    today = value.get("today")
    if isinstance(today, str) and today.strip():
        result["today"] = today.strip()[:120]
    return result


def fallback_plan(subject: str, now: datetime) -> dict[str, Any]:
    """Planner unavailable: search the subject itself, plus the subject pinned to this month."""
    subject = " ".join(subject.split())[:MAX_QUERY_CHARS] or "news"
    month = now.strftime("%B %Y")
    queries = [{"q": subject, "intent": "news", "days": None, "domains": []}]
    if month not in subject:
        queries.append({"q": f"{subject} {month}"[:MAX_QUERY_CHARS + 20], "intent": "news", "days": None, "domains": []})
    return {"mode": "research", "assumption": "", "queries": queries, "source": "fallback"}


def _clean_queries(raw: Any) -> list[dict[str, Any]]:
    queries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            item = {"q": item}
        if not isinstance(item, Mapping):
            continue
        text = item.get("q")
        text = " ".join(text.split())[:MAX_QUERY_CHARS] if isinstance(text, str) else ""
        if len(text) < 3 or text.lower() in seen:
            continue
        seen.add(text.lower())
        days = item.get("days")
        days = days if isinstance(days, int) and not isinstance(days, bool) and 1 <= days <= MAX_DAYS else None
        intent = item.get("intent") if item.get("intent") in INTENTS else "news"
        queries.append({"q": text, "intent": intent, "days": days, "domains": normalize_domains(item.get("domains"), limit=5)})
        if len(queries) == MAX_QUERIES:
            break
    return queries


def parse_plan(text: Any) -> dict[str, Any] | None:
    """The planner's JSON (code fences and prose tolerated), clamped; None when unusable."""
    if not isinstance(text, str):
        return None
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        raw = json.loads(text[start:end + 1])
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    queries = _clean_queries(raw.get("queries"))
    mode = raw.get("mode")
    if mode not in {"thread", "research"}:
        if not queries:
            return None
        mode = "research"
    assumption = raw.get("assumption")
    assumption = " ".join(assumption.split())[:MAX_ASSUMPTION_CHARS].strip(" .") if isinstance(assumption, str) else ""
    if mode == "research" and not queries:
        return None
    return {"mode": mode, "assumption": assumption, "queries": queries, "source": "planner"}


def apply_requirement(plan: dict[str, Any] | None, required: bool | None, subject: str, now: datetime) -> dict[str, Any]:
    """Combine the planner (or its failure) with the app's tri-state research flag."""
    if required is False:
        return {"mode": "thread", "assumption": "", "queries": [], "source": "app"}
    if plan is None:
        return fallback_plan(subject, now)
    if required is True and plan["mode"] == "thread":
        queries = plan["queries"] or fallback_plan(subject, now)["queries"]
        return {"mode": "research", "assumption": plan["assumption"], "queries": queries, "source": "forced"}
    return plan


def message_text(message: Mapping[str, Any]) -> str:
    return "\n".join(block["text"] for block in message.get("content", [])
                     if block.get("type") == "text" and not block["text"].startswith("Attached context"))


def recent_dialogue(messages: Sequence[Mapping[str, Any]], limit: int = 6) -> str:
    """The last few turns before the latest request, oldest first, trimmed."""
    turns = [(m["role"], message_text(m).strip()) for m in messages if m["role"] in {"user", "assistant"}]
    turns = [(role, text) for role, text in turns if text and not text.startswith("Requested reply operation")]
    if turns and turns[-1][0] == "user":
        turns = turns[:-1]  # The latest request is passed separately.
    lines = [f"{role}: {text[:900 if role == 'assistant' else 600]}" for role, text in turns[-limit:]]
    return "\n".join(lines) or "(none)"


def source_lines(sources: Mapping[int, Mapping[str, Any]], limit: int = 20) -> str:
    rows = [f"[{number}] {str(src.get('title') or src.get('url'))[:160]}" + (f" ({src['publicationDate'][:10]})" if isinstance(src.get("publicationDate"), str) and src["publicationDate"] else "")
            for number, src in sorted(sources.items())[-limit:]]
    return "\n".join(rows) or "(none)"


def planner_prompt(*, request: str, newsroom: Mapping[str, Any], now: datetime, dialogue: str,
                   sources: Mapping[int, Mapping[str, Any]], required: bool | None) -> str:
    zone = newsroom.get("timezone") or DEFAULT_TIMEZONE
    today = newsroom.get("today") or now.strftime("%A, %B %d, %Y")
    market = newsroom.get("homeMarket") or "not set"
    domains = ", ".join(newsroom.get("preferredDomains") or []) or "none"
    flag = {True: "New research is required for this turn: use mode \"research\".\n", None: "", False: ""}[required]
    return (
        "Plan the research for the producer's latest request. Do not answer it.\n\n"
        f"Today: {today} (timezone {zone}). Home market: {market}. Preferred domains: {domains}.\n\n"
        f"Recent conversation (oldest first):\n{dialogue}\n\n"
        f"Sources already recorded in this conversation (reusable with their numbers):\n{source_lines(sources)}\n\n"
        f"Latest request:\n{request[:1500]}\n\n"
        f"{flag}Reply with JSON of this shape: {PLAN_SCHEMA}\n\n{PLANNER_RULES}")
