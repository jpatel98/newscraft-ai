"""Raw tape in the writing call.

The app attaches transcripts to a conversation and seeds every speaker turn as
a citation whose URL is ``transcript://<id>#t=<startMs>,<endMs>`` and whose
excerpt is the verbatim words of that turn. The same turns arrive in the AG-UI
context entry whose description starts with ``Attached transcript turns``.

This module is deterministic on purpose: the SOT candidates and the quote
check are computed here, not asked of the model, so the eval can assert them.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, Final
from urllib.parse import unquote, urlsplit

TRANSCRIPT_CONTEXT_PREFIX: Final = "Attached transcript turns"
TRANSCRIPT_SCHEME: Final = "transcript"
_TAPE_URL = re.compile(r"^transcript://([^#?/]+)#t=(\d+),(\d+)$", re.I)

# Words that mark a turn as a usable clip rather than a reporter's question.
_STRONG = re.compile(r"\b(?:we|i|our|my|never|always|will|won't|can't|must|refuse|demand|because|unacceptable|"
                     r"sorry|angry|scared|devastat\w*|heartbreak\w*|proud|fight\w*|promise\w*|guarantee\w*)\b", re.I)
_NUMBER = re.compile(r"\d")
_QUESTION_START = re.compile(r"^(?:so|and|but)?\s*(?:what|why|how|when|where|who|do|does|did|is|are|can|could|will|would|should)\b", re.I)
_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s']", re.U)


def parse_tape_url(url: str) -> dict[str, Any] | None:
    """``{"transcriptId", "startMs", "endMs"}`` for a tape citation URL, else None."""
    match = _TAPE_URL.match(url.strip()) if isinstance(url, str) else None
    if not match:
        return None
    start, end = int(match.group(2)), int(match.group(3))
    if end < start:
        return None
    return {"transcriptId": unquote(match.group(1)), "startMs": start, "endMs": end}


def validate_tape_citation(source: Mapping[str, object]) -> None:
    """Raise ValueError unless ``source`` is a well-formed seeded tape citation.

    Tape citations never reach the public-page fetcher: they identify private
    audio the app serves to its own user, so only the shape is checked here.
    """
    url = source.get("url")
    if not isinstance(url, str) or len(url) > 2000 or "\x00" in url:
        raise ValueError("tape citation url is invalid")
    parsed = urlsplit(url)
    if parsed.scheme.lower() != TRANSCRIPT_SCHEME or parsed.username or parsed.password:
        raise ValueError("tape citation url is invalid")
    ref = parse_tape_url(url)
    if ref is None:
        raise ValueError("tape citation url is invalid")
    if source.get("transcriptId") not in (None, ref["transcriptId"]):
        raise ValueError("tape citation transcript id does not match its url")
    for key in ("startMs", "endMs"):
        value = source.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
            raise ValueError("tape citation times are invalid")
    if source.get("startMs") is not None and source.get("endMs") is not None and source["endMs"] < source["startMs"]:
        raise ValueError("tape citation times are invalid")


def is_tape_citation(source: Mapping[str, object]) -> bool:
    url = source.get("url")
    return isinstance(url, str) and parse_tape_url(url) is not None


def clock(ms: int) -> str:
    """0:07, 12:45, 1:02:03 — the way a producer reads a timecode."""
    total = max(0, int(ms) // 1000)
    hours, rest = divmod(total, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


def transcript_turns(messages: Sequence[Mapping[str, Any]], header: str) -> list[dict[str, Any]]:
    """Every seeded speaker turn in the conversation's attached context, in tape order.

    ``header`` is the context block's first line (``portable.CONTEXT_HEADER``).
    Each turn: ``transcriptId``, ``title``, ``turnId``, ``citationNumber``,
    ``speaker``, ``startMs``, ``endMs``, ``text``.
    """
    turns: list[dict[str, Any]] = []
    for message in messages:
        for block in message.get("content", []):
            text = block.get("text", "") if block.get("type") == "text" else ""
            if not text.startswith(header):
                continue
            try:
                items = json.loads(text.split("\n", 1)[1])
            except (ValueError, IndexError):
                continue
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, Mapping) or not str(item.get("description", "")).startswith(TRANSCRIPT_CONTEXT_PREFIX):
                    continue
                try:
                    transcripts = json.loads(item["value"])
                except (ValueError, TypeError, KeyError):
                    continue
                for transcript in transcripts if isinstance(transcripts, list) else []:
                    if not isinstance(transcript, Mapping):
                        continue
                    for turn in transcript.get("turns", []) if isinstance(transcript.get("turns"), list) else []:
                        if not isinstance(turn, Mapping) or not isinstance(turn.get("text"), str):
                            continue
                        try:
                            turns.append({
                                "transcriptId": str(transcript.get("id", "")),
                                "title": str(transcript.get("title", "")),
                                "turnId": str(turn.get("turnId", "")),
                                "citationNumber": int(turn["citationNumber"]),
                                "speaker": str(turn.get("speaker", "")),
                                "startMs": int(turn["startMs"]),
                                "endMs": int(turn["endMs"]),
                                "text": turn["text"].strip(),
                            })
                        except (KeyError, TypeError, ValueError):
                            continue
    return turns


def _score(turn: Mapping[str, Any], *, min_seconds: float, max_seconds: float, reporter: str | None) -> float:
    seconds = (turn["endMs"] - turn["startMs"]) / 1000
    if seconds < min_seconds or seconds > max_seconds or not turn["text"]:
        return 0.0
    text = turn["text"]
    if reporter and turn["speaker"] == reporter:
        return 0.0
    score = 1.0
    # A clip in the middle of the window plays best on air.
    score += 1.0 - abs(seconds - (min_seconds + max_seconds) / 2) / max_seconds
    score += min(3, len(_STRONG.findall(text))) * 0.5
    score += 0.5 if _NUMBER.search(text) else 0.0
    if text.rstrip().endswith("?") or _QUESTION_START.match(text):
        score -= 1.5
    if text.count(" ") < 6:
        score -= 0.5
    return score


def pick_sots(turns: Sequence[Mapping[str, Any]], *, n: int = 3, min_seconds: float = 4.0, max_seconds: float = 12.0,
              speaker: str | None = None) -> list[dict[str, Any]]:
    """The ``n`` best clip candidates: in/out timecodes, speaker, verbatim words, citation number.

    The reporter is taken to be the speaker who asks the most questions; their
    turns are never clips. Candidates come back strongest first and carry the
    one-line ``why`` the producer sees.
    """
    questions: dict[str, int] = {}
    for turn in turns:
        if turn["text"].rstrip().endswith("?"):
            questions[turn["speaker"]] = questions.get(turn["speaker"], 0) + 1
    reporter = max(questions, key=questions.get) if questions and len({t["speaker"] for t in turns}) > 1 else None
    scored = []
    for turn in turns:
        if speaker and turn["speaker"] != speaker:
            continue
        value = _score(turn, min_seconds=min_seconds, max_seconds=max_seconds, reporter=reporter)
        if value > 0:
            scored.append((value, turn))
    scored.sort(key=lambda pair: (-pair[0], pair[1]["startMs"]))
    picks = []
    for value, turn in scored[: max(0, n)]:
        seconds = (turn["endMs"] - turn["startMs"]) / 1000
        why = []
        if _STRONG.search(turn["text"]):
            why.append("firsthand or emotional")
        if _NUMBER.search(turn["text"]):
            why.append("carries a figure")
        picks.append({
            "citationNumber": turn["citationNumber"],
            "transcriptId": turn["transcriptId"],
            "speaker": turn["speaker"],
            "in": clock(turn["startMs"]),
            "out": clock(turn["endMs"]),
            "startMs": turn["startMs"],
            "endMs": turn["endMs"],
            "seconds": round(seconds, 1),
            "verbatim": turn["text"],
            "why": ", ".join(why) or "clean, usable length",
        })
    return picks


def sot_listing(picks: Sequence[Mapping[str, Any]]) -> str:
    """The candidate block appended to the writer prompt."""
    if not picks:
        return ""
    rows = [f"- [{p['citationNumber']}] IN {p['in']} OUT {p['out']} ({p['seconds']}s) {p['speaker']}: \"{p['verbatim']}\" ({p['why']})"
            for p in picks]
    return ("Clip candidates from the attached tape, strongest first. Use one of these as the SOT unless the producer named a clip. "
            "Quote the words exactly as written here; write the SOT line as [IN <in> -- OUT <out> | NAME, TITLE] followed by the quote. "
            "Never shorten a quote with an ellipsis or change a word.\n" + "\n".join(rows))


def _norm(text: str) -> str:
    return _WS.sub(" ", _PUNCT.sub(" ", text.replace("’", "'"))).strip().casefold()


_SOT_CUE = re.compile(r"\{\s*SOT\s*\}", re.I)
_ANY_CUE = re.compile(r"\{[^}\n]*\}")


def sot_segments(script: str) -> list[str]:
    """The text under each {SOT} cue, up to the next cue. Only these lines are the clip."""
    body = re.split(r"\n\s*(?:Super|Banner|Sources|CHECK)\s*:", "\n" + (script or ""), maxsplit=1, flags=re.I)[0]
    segments = []
    for match in _SOT_CUE.finditer(body):
        rest = body[match.end():]
        nxt = _ANY_CUE.search(rest)
        segments.append(rest[: nxt.start()] if nxt else rest)
    return segments


def quote_problems(script: str, turns: Sequence[Mapping[str, Any]]) -> list[str]:
    """Quoted lines under a {SOT} cue that do not occur verbatim in the attached tape.

    Only checked when tape is attached, and only inside SOT segments: a quote
    from a release or a page elsewhere in the script is the writer's business.
    A quote is a double-quoted run of four or more words; it must appear word
    for word (ignoring case and punctuation, on word boundaries) inside one
    speaker turn.
    """
    if not turns:
        return []
    normalized_turns = [f" {_norm(turn['text'])} " for turn in turns]
    problems = []
    for segment in sot_segments(script):
        for quote in re.findall(r"[\"“]([^\"”]{12,}?)[\"”]", segment):
            wanted = _norm(quote)
            if len(wanted.split()) < 4:
                continue
            if not any(f" {wanted} " in turn for turn in normalized_turns):
                problems.append(f"The SOT quote \"{quote[:60]}\" is not word-for-word in the attached tape; use the exact words of one turn.")
    return problems
