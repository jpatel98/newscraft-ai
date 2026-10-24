"""Score the broadcast writing skill: how follow-ups are routed, and whether scripts meet the house rules.

Cases live in eval/broadcast (routing.json, stories.json). Model replies are kept in eval/broadcast/cassette.json,
keyed by a hash of the exact prompt, so the default replay mode is free and runs in CI: a change to the skill or the
prompts that is not re-recorded shows up as a missing cassette entry. Record with the production model (a few cents):

    DEEPSEEK_API_KEY=... python services/hermes-chat/scripts/broadcast_eval.py --record

Replay writes eval/broadcast/report.json; the process exits 1 when a routing case or a writing check fails.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services/hermes-chat/src"))

from hermes_chat import broadcast_writing as bw  # noqa: E402
from hermes_chat.portable import FAST_INSTRUCTIONS  # noqa: E402
from hermes_chat.product_prompt import append_product_identity  # noqa: E402

EVAL = ROOT / "eval/broadcast"
MODEL = "deepseek-flash"
BASE = append_product_identity(FAST_INSTRUCTIONS)
IMPERIAL = ("FEET", "FOOT", "ACRES", "MILES", "MPH", "POUNDS", "FAHRENHEIT", "INCHES", "YARDS")
SPELLED = re.compile(r"\b(?:ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|THIRTY|FORTY|"
                     r"FIFTY|SIXTY|SEVENTY|EIGHTY|NINETY)\b")
CUES = {"ocvo": ("{ON CAM}", "{VO}"), "dve": ("{VO}",), "suvo": ("{SUVO}",), "sotvo": ("{SOT}",), "headline": ("{ANT VO}",)}


class Cassette:
    def __init__(self, path: Path, record: bool):
        self.path, self.record = path, record
        self.data = json.loads(path.read_text()) if path.exists() else {}
        self.used: set[str] = set()
        if record:
            import httpx  # Only recording needs the network.
            self.http = httpx.Client(timeout=120)
            self.key = os.environ["DEEPSEEK_API_KEY"]

    def complete(self, system: str, messages: list[dict], max_tokens: int) -> str:
        key = hashlib.sha256(json.dumps([MODEL, system, messages, max_tokens], ensure_ascii=False).encode()).hexdigest()[:24]
        self.used.add(key)
        if key in self.data:
            return self.data[key]
        if not self.record:
            raise KeyError(f"no recorded reply for prompt {key}; re-record with --record")
        for attempt in range(3):
            try:
                reply = self.http.post("https://api.deepseek.com/anthropic/v1/messages", headers={
                    "x-api-key": self.key, "anthropic-version": "2023-06-01"}, json={
                    "model": MODEL, "max_tokens": max_tokens, "system": system, "messages": messages, "thinking": {"type": "disabled"}})
                reply.raise_for_status()
                text = "".join(b.get("text", "") for b in reply.json()["content"] if b["type"] == "text")
                break
            except Exception:
                if attempt == 2:
                    raise
        self.data[key] = text
        return text

    def save(self):
        if self.record:  # Keep only replies the current prompts use.
            self.data = {k: v for k, v in self.data.items() if k in self.used}
            self.path.write_text(json.dumps(self.data, indent=1, ensure_ascii=False, sort_keys=True) + "\n")


def classify(cassette, request, last_answer, output_action=None):
    """What the worker would do with this turn: (intent, format), with intent "none" when the skill is not involved."""
    decision = bw.route(request, output_action=output_action, last_answer=last_answer)
    if decision is None:
        return "none", None
    if decision["intent"] != "classify":
        return decision["intent"], decision["format"]
    text = cassette.complete(BASE, [{"role": "user", "content": bw.classifier_prompt(request, last_answer)}], bw.CLASSIFIER_MAX_OUTPUT)
    parsed = (bw.parse_intent(text, decision["format"], request=request, previous=bw.script_format(last_answer))
              or bw.fallback_intent(request, decision))
    if parsed is None or parsed["intent"] == "other":
        return "other", None
    return parsed["intent"], parsed["format"]


def lint(text: str, fmt: str, *, mode: str, allow_units=(), previous: str = "", shorter=False, must=(), must_not=(), max_lines=0) -> list[str]:
    """House-rule checks that need no judgement."""
    problems = []
    body = re.split(r"\n\s*(?:Super|Banner|Sources|CHECK)\s*:", "\n" + text, maxsplit=1, flags=re.I)[0]
    if mode == "question":
        if any(cue in text for cue in ("{ON CAM}", "{VO}", "{SUVO}", "{SOT}")):
            problems.append("question answered with a script")
        return problems
    for cue in CUES.get(fmt, ()):
        if cue not in text:
            problems.append(f"missing {cue}")
    for line in body.splitlines():
        spoken = re.sub(r"\[.*?\]|\{.*?\}|\(.*?\)", "", line).strip()
        if spoken and re.search(r"[a-z]", spoken):
            problems.append(f"lower case in spoken line: {spoken[:50]}")
    if re.search(r"\[\d+\]", body):
        problems.append("citation marker in spoken copy")
    if re.search(r"^#|\*\*|```", text, re.M):
        problems.append("markdown")
    if "—" in text:
        problems.append("em dash")
    if re.search(r"\d{3}[-.]\d{3}[-.]\d{4}|1-800|https?://|\bwww\.", text):
        problems.append("phone number or URL")
    for unit in IMPERIAL:
        if unit not in allow_units and re.search(rf"\b{unit}\b", body):
            problems.append(f"imperial unit {unit}")
    if SPELLED.search(body):
        problems.append(f"spelled-out number {SPELLED.search(body).group(0)}")
    banner = re.search(r"Banner:\s*\n?\s*(.+)", text)
    if banner and (banner.group(1).isupper() or len(banner.group(1)) > 60) and fmt not in ("tease", "banner"):
        problems.append(f"banner not sentence case or too long: {banner.group(1)[:60]}")
    words = bw.spoken_words(text)
    budget = bw.WORD_BUDGET.get(fmt)
    if mode == "new_script" and budget and words > budget * 1.15:
        problems.append(f"{words} spoken words, budget {budget}")
    if shorter and previous and words > bw.spoken_words(previous) * 0.85:
        problems.append(f"'shorter' went from {bw.spoken_words(previous)} to {words} words")
    if max_lines and len([l for l in body.splitlines() if l.strip() and not re.match(r"^\s*[\[{(]", l)]) > max_lines:
        problems.append(f"more than {max_lines} spoken lines")
    problems += [f"missing {m}" for m in must if m not in text.upper()]
    problems += [f"still says {m}" for m in must_not if m in text.upper()]
    return problems


def write(cassette, fmt, mode, messages, previous=""):
    """The writing call, then the same one-shot repair the worker makes when a measurable house rule is broken."""
    system = BASE + "\n\n" + bw.instructions(fmt)
    *history, last = messages
    material = mode != "new_script" or bw.has_material(last["content"], prior_answer=bool(previous))
    prompt = bw.writer_prompt(fmt, mode=mode, material=material, previous=previous)
    sent = [*history, {"role": "user", "content": last["content"] + "\n\n" + prompt}]
    text = cassette.complete(system, sent, 1500)
    problems = bw.check(text, fmt, mode=mode, request=last["content"], previous=previous)
    if problems:
        fixed = cassette.complete(system, [*sent, {"role": "assistant", "content": text},
                                           {"role": "user", "content": bw.repair_prompt(problems)}], 1500)
        if bw.script_format(fixed):
            text = fixed
    return text


def run_story(cassette, story):
    results = []
    intent, fmt = classify(cassette, story["request"], "")
    text = write(cassette, fmt, "new_script", [{"role": "user", "content": story["request"]}]) if fmt else ""
    if story.get("expect") == "no_script":
        problems = [] if not bw.script_format(text) else ["wrote a script with nothing to write from"]
    else:
        problems = lint(text, fmt, mode="new_script", allow_units=story.get("allow_units", ()))
    results.append({"story": story["id"], "step": "new", "format": fmt, "problems": problems, "text": text})
    history = [{"role": "user", "content": story["request"]}, {"role": "assistant", "content": text}]
    for note in story["notes"]:
        got, nfmt = classify(cassette, note["text"], text)
        problems = [] if got == note["intent"] else [f"routed as {got}, expected {note['intent']}"]
        if note.get("format") and nfmt != note["format"]:
            problems.append(f"format {nfmt}, expected {note['format']}")
        new = write(cassette, nfmt, got, [*history, {"role": "user", "content": note["text"]}], previous=text) if nfmt else ""
        problems += lint(new, nfmt, mode=got, previous=text, shorter=note.get("shorter", False),
                         allow_units=note.get("allow_units", story.get("allow_units", ())), must=note.get("must", ()),
                         must_not=note.get("must_not", ()), max_lines=note.get("max_lines", 0))
        results.append({"story": story["id"], "step": note["text"], "format": nfmt, "problems": problems, "text": new})
        history += [{"role": "user", "content": note["text"]}, {"role": "assistant", "content": new}]
        if got != "question":
            text = new
    return results


def evaluate(record=False) -> dict:
    cassette = Cassette(EVAL / "cassette.json", record)
    routing = json.loads((EVAL / "routing.json").read_text())
    stories = json.loads((EVAL / "stories.json").read_text())["stories"]

    def route_case(case):
        intent, fmt = classify(cassette, case["request"], routing["contexts"][case["context"]])
        ok = intent in case["intent"] and (case["format"] is None or fmt in case["format"])
        return {"id": case["id"], "request": case["request"], "got": [intent, fmt], "ok": ok}

    with concurrent.futures.ThreadPoolExecutor(8 if record else 1) as pool:
        routed = list(pool.map(route_case, routing["cases"]))
        written = [step for steps in pool.map(lambda s: run_story(cassette, s), stories) for step in steps]
    cassette.save()
    report = {
        "model": MODEL,
        "routing": {"passed": sum(r["ok"] for r in routed), "total": len(routed), "failures": [r for r in routed if not r["ok"]]},
        "writing": {"passed": sum(not w["problems"] for w in written), "total": len(written),
                    "failures": [{k: w[k] for k in ("story", "step", "format", "problems")} for w in written if w["problems"]]},
        "scripts": written,
    }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--record", action="store_true", help="call the production model for prompts with no recorded reply")
    args = parser.parse_args()
    report = evaluate(record=args.record)
    (EVAL / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")
    for part in ("routing", "writing"):
        print(f"{part}: {report[part]['passed']}/{report[part]['total']}")
        for failure in report[part]["failures"]:
            print("  FAIL", json.dumps({k: v for k, v in failure.items() if k != "text"}, ensure_ascii=False)[:300])
    sys.exit(0 if not report["routing"]["failures"] and not report["writing"]["failures"] else 1)


if __name__ == "__main__":
    main()
