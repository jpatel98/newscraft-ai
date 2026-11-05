import json
import unittest

from newscraft_agent import broadcast_writing as bw
from newscraft_agent import tape
from newscraft_agent.portable import CONTEXT_HEADER

# A 20-second scrum: reporter asks, mayor answers. Times in ms. This is the
# same shape the app seeds (transcriptCitationContext in agent/transport.ts).
TURNS = [
    {"turnId": "u1", "citationNumber": 4, "speaker": "Reporter", "startMs": 0, "endMs": 2400, "timecode": "0:00",
     "text": "Mayor, is the bridge closing?"},
    {"turnId": "u2", "citationNumber": 5, "speaker": "Mayor Brown", "startMs": 2500, "endMs": 9800, "timecode": "0:02",
     "text": "The bridge closes Monday and it stays closed for eight months. We had no choice."},
    {"turnId": "u3", "citationNumber": 6, "speaker": "Reporter", "startMs": 10000, "endMs": 11500, "timecode": "0:10",
     "text": "What about the shop owners?"},
    {"turnId": "u4", "citationNumber": 7, "speaker": "Mayor Brown", "startMs": 11600, "endMs": 13100, "timecode": "0:11",
     "text": "Yeah."},
    {"turnId": "u5", "citationNumber": 8, "speaker": "Mayor Brown", "startMs": 13200, "endMs": 19900, "timecode": "0:13",
     "text": "I'm sorry for them, I really am, and we will have a ferry running by spring."},
]
TRANSCRIPT_DESCRIPTION = "Attached transcript turns with exact citation numbers (quote verbatim; cite the turn for every SOT with its IN/OUT)"
CONTEXT = [{"description": "Newsroom context", "value": "{}"},
           {"description": TRANSCRIPT_DESCRIPTION,
            "value": json.dumps([{"id": "tr_mayor", "title": "Mayor scrum", "durationMs": 20000, "turns": TURNS}])}]
MESSAGES = [{"role": "user", "content": [{"type": "text", "text": CONTEXT_HEADER + "\n" + json.dumps(CONTEXT)}]},
            {"role": "user", "content": [{"type": "text", "text": "/sotvo bridge closure"}]}]


def context_message(text):
    return [{"role": "user", "content": [{"type": "text", "text": text}]}]


class TapeUrlTests(unittest.TestCase):
    def test_parse_accepts_a_range_and_rejects_everything_else(self):
        self.assertEqual(tape.parse_tape_url("transcript://tr_mayor#t=2500,9800"), {"transcriptId": "tr_mayor", "startMs": 2500, "endMs": 9800})
        self.assertEqual(tape.parse_tape_url("transcript://a%20b#t=0,1")["transcriptId"], "a b")
        for bad in ("transcript://tr", "transcript://tr#t=5,3", "https://x.test#t=1,2", "transcript://a/b#t=1,2",
                    "transcript://tr#t=-1,2", "transcript://tr#t=1.5,2", "transcript://tr#t=1,2,3", None):
            with self.subTest(bad=bad):
                self.assertIsNone(tape.parse_tape_url(bad))

    def test_validate_accepts_well_formed_citations(self):
        url = "transcript://tr#t=1,2"
        for source in ({"url": url}, {"url": url, "transcriptId": "tr", "startMs": 1, "endMs": 2},
                       {"url": "TRANSCRIPT://tr#t=1,2"}):
            with self.subTest(source=source):
                tape.validate_tape_citation(source)
        self.assertTrue(tape.is_tape_citation({"url": url}))
        self.assertFalse(tape.is_tape_citation({"url": "https://x.test/a"}))
        self.assertFalse(tape.is_tape_citation({}))

    def test_validate_rejects_forged_or_malformed_citations(self):
        url = "transcript://tr#t=1,2"
        for label, source in (
                ("transcript id disagrees with the url", {"url": url, "transcriptId": "other"}),
                ("reversed times", {"url": url, "startMs": 5, "endMs": 2}),
                ("negative time", {"url": url, "startMs": -1}),
                ("boolean time", {"url": url, "startMs": True}),
                ("string time", {"url": url, "endMs": "2"}),
                ("fractional time", {"url": url, "endMs": 1.5}),
                ("no url", {"transcriptId": "tr"}),
                ("non-string url", {"url": 5}),
                ("public page", {"url": "https://x.test/a#t=1,2"}),
                ("no time range", {"url": "transcript://tr"}),
                ("credentials in the url", {"url": "transcript://user:pw@tr#t=1,2"}),
                ("oversized url", {"url": "transcript://" + "a" * 2000 + "#t=1,2"}),
                ("NUL byte", {"url": "transcript://tr\x00#t=1,2"})):
            with self.subTest(label), self.assertRaises(ValueError):
                tape.validate_tape_citation(source)

    def test_clock(self):
        self.assertEqual(tape.clock(0), "0:00")
        self.assertEqual(tape.clock(134200), "2:14")
        self.assertEqual(tape.clock(3723000), "1:02:03")


class TurnsAndSotsTests(unittest.TestCase):
    def setUp(self):
        self.turns = tape.transcript_turns(MESSAGES, CONTEXT_HEADER)

    def test_turns_are_read_from_the_attached_context(self):
        self.assertEqual([t["citationNumber"] for t in self.turns], [4, 5, 6, 7, 8])
        self.assertEqual(self.turns[1]["transcriptId"], "tr_mayor")
        self.assertEqual(self.turns[1]["speaker"], "Mayor Brown")
        self.assertEqual(tape.transcript_turns([MESSAGES[1]], CONTEXT_HEADER), [])

    def test_damaged_context_yields_no_turns_instead_of_failing_the_run(self):
        good_turn = {"turnId": "a", "citationNumber": 1, "speaker": "S", "startMs": 0, "endMs": 5000, "text": "  Hello there.  "}

        def entry(transcripts, description=TRANSCRIPT_DESCRIPTION):
            value = transcripts if isinstance(transcripts, str) else json.dumps(transcripts)
            return context_message(CONTEXT_HEADER + "\n" + json.dumps([{"description": description, "value": value}]))

        broken = {
            "header only": context_message(CONTEXT_HEADER),
            "block is not json": context_message(CONTEXT_HEADER + "\nnot json"),
            "block is not a list": context_message(CONTEXT_HEADER + '\n{"a": 1}'),
            "entry for another description": entry([{"id": "t", "turns": [good_turn]}], description="Newsroom context"),
            "value is not json": entry("not json"),
            "value is not a list": entry({"id": "t", "turns": [good_turn]}),
            "transcript is not an object": entry(["tr"]),
            "turns is not a list": entry([{"id": "t", "turns": "x"}]),
            "turn missing its citation number": entry([{"id": "t", "turns": [{k: v for k, v in good_turn.items() if k != "citationNumber"}]}]),
            "turn text is not a string": entry([{"id": "t", "turns": [{**good_turn, "text": 5}]}]),
            "turn time is not a number": entry([{"id": "t", "turns": [{**good_turn, "startMs": "abc"}]}]),
        }
        for label, messages in broken.items():
            with self.subTest(label):
                self.assertEqual(tape.transcript_turns(messages, CONTEXT_HEADER), [])
        # One damaged turn does not hide its good neighbour, and the text is trimmed.
        mixed = entry([{"id": "t", "turns": [{**good_turn, "citationNumber": "x"}, {**good_turn, "citationNumber": 2}]}])
        self.assertEqual([(t["citationNumber"], t["text"]) for t in tape.transcript_turns(mixed, CONTEXT_HEADER)], [(2, "Hello there.")])

    def test_pick_sots_prefers_the_answers_not_the_questions(self):
        picks = tape.pick_sots(self.turns, n=3)
        # The apology outranks the announcement (more firsthand language); "Yeah." is too short; reporter turns are never clips.
        self.assertEqual([p["citationNumber"] for p in picks], [8, 5])
        best, second = picks
        self.assertEqual((best["in"], best["out"], best["seconds"]), ("0:13", "0:19", 6.7))
        self.assertEqual(best["verbatim"], TURNS[4]["text"])
        self.assertIn("firsthand", best["why"])
        self.assertEqual((second["in"], second["out"], second["seconds"]), ("0:02", "0:09", 7.3))
        self.assertEqual(second["verbatim"], TURNS[1]["text"])
        # Offsets are the turn's own times, within 500 ms of the tape.
        for pick, turn in ((best, TURNS[4]), (second, TURNS[1])):
            self.assertLessEqual(abs(pick["startMs"] - turn["startMs"]), 500)
            self.assertLessEqual(abs(pick["endMs"] - turn["endMs"]), 500)

    def test_pick_sots_honours_speaker_length_window_and_count(self):
        def numbers(**options):
            return [p["citationNumber"] for p in tape.pick_sots(self.turns, **options)]

        self.assertEqual(numbers(speaker="Reporter"), [])
        self.assertEqual(numbers(speaker="Nobody"), [])
        self.assertEqual(numbers(speaker="Mayor Brown"), [8, 5])
        self.assertEqual(numbers(max_seconds=7.0), [8])  # 6.7 s fits, 7.3 s does not.
        self.assertEqual(numbers(min_seconds=7.0), [5])
        self.assertEqual(numbers(n=1), [8])
        self.assertEqual(numbers(n=0), [])
        self.assertEqual(numbers(n=-1), [])
        self.assertEqual(tape.pick_sots([]), [])

    def test_a_lone_speaker_is_not_mistaken_for_the_reporter(self):
        # Reporter detection needs two voices; a monologue that ends on a question is still the interviewee.
        monologue = [{"transcriptId": "solo", "title": "", "turnId": "s1", "citationNumber": 1, "speaker": "Chief Ruiz",
                      "startMs": 0, "endMs": 6000, "text": "We never had a plan, so who would build it?"}]
        self.assertEqual([p["citationNumber"] for p in tape.pick_sots(monologue)], [1])

    def test_picks_are_whole_turns_with_a_playable_citation_url(self):
        by_number = {t["citationNumber"]: t for t in self.turns}
        for pick in tape.pick_sots(self.turns, n=5):
            turn = by_number[pick["citationNumber"]]
            self.assertEqual(pick["verbatim"], turn["text"])
            self.assertEqual(tape.parse_tape_url(pick["url"]),
                             {"transcriptId": turn["transcriptId"], "startMs": turn["startMs"], "endMs": turn["endMs"]})

    def test_two_tapes_keep_their_own_reporter_and_can_be_picked_separately(self):
        second = [
            {"turnId": "b1", "citationNumber": 20, "speaker": "Chief Ruiz", "startMs": 0, "endMs": 2000,
             "text": "Why did the council vote that way?"},
            {"turnId": "b2", "citationNumber": 21, "speaker": "Councillor Lee", "startMs": 2100, "endMs": 9000,
             "text": "Because families asked us, and I will not apologise for 40 new buses."},
        ]
        turns = self.turns + [{**t, "transcriptId": "tr_council", "title": "Council"} for t in second]
        everything = tape.pick_sots(turns, n=10)
        self.assertEqual({p["citationNumber"] for p in everything}, {5, 8, 21})
        only_council = tape.pick_sots(turns, transcript_id="tr_council")
        self.assertEqual([(p["transcriptId"], p["citationNumber"]) for p in only_council], [("tr_council", 21)])
        self.assertEqual(tape.pick_sots(turns, transcript_id="missing"), [])
        # Diarization labels are local to each interview: the same label can
        # mean interviewer on one recording and interviewee on another.
        reused = [
            {"transcriptId": tape_id, "speaker": speaker, "text": text,
             "startMs": start, "endMs": end, "citationNumber": number}
            for tape_id, speaker, text, start, end, number in (
                ("A", "Speaker 1", "Why did our community never get the promised homes?", 0, 6000, 30),
                ("A", "Speaker 2", "We will build 40 homes for our families.", 6500, 13500, 31),
                ("B", "Speaker 2", "Why did our community never get the promised homes?", 0, 6000, 32),
                ("B", "Speaker 1", "We will build 80 homes for our families.", 6500, 13500, 33))]
        self.assertEqual({p["citationNumber"] for p in tape.pick_sots(reused, n=10)}, {31, 33})

    def test_sot_listing_quotes_verbatim(self):
        listing = tape.sot_listing(tape.pick_sots(self.turns))
        self.assertIn('[8] IN 0:13 OUT 0:19 (6.7s) Mayor Brown: "I\'m sorry for them', listing)
        self.assertIn('[5] IN 0:02 OUT 0:09 (7.3s) Mayor Brown: "The bridge closes Monday', listing)
        self.assertIn("Never shorten a quote", listing)
        self.assertEqual(tape.sot_listing([]), "")


SCRIPT_OK = """{ON CAM}
THE BRIDGE IS CLOSING... AND THE MAYOR SAYS THERE WAS NO WAY AROUND IT.
{VO}
IT SHUTS MONDAY FOR EIGHT MONTHS OF REPAIRS.
{SOT}
[IN 0:02 -- OUT 0:09 | MAYOR BROWN]
"THE BRIDGE CLOSES MONDAY AND IT STAYS CLOSED FOR EIGHT MONTHS. WE HAD NO CHOICE."
{VO}
A FERRY FOR THE EAST BANK IS PROMISED BY SPRING.

Banner:
Bridge closes Monday"""

SCRIPT_BAD = SCRIPT_OK.replace("WE HAD NO CHOICE.", "WE HAD NO OTHER OPTION.")
CUE = "IN 0:02 -- OUT 0:09"  # The right cue for the quoted turn in SCRIPT_OK.
# A second SOT, quoting the apology, in place of SCRIPT_OK's closing VO line.
SECOND_SOT = '{SOT}\n%s"I\'M SORRY FOR THEM, I REALLY AM, AND WE WILL HAVE A FERRY RUNNING BY SPRING."'
VO_LINE = "{VO}\nA FERRY FOR THE EAST BANK IS PROMISED BY SPRING."

# Cues that must be rejected, with the part of the message the producer needs to see. A tuple means either wording is fine.
BAD_CUES = (
    # Trimmed: no word timing exists, so only the whole turn's own times are verifiable.
    ("IN 0:03 -- OUT 0:08", "cue the whole turn"),
    ("IN 0:02 -- OUT 0:15", "cue the whole turn"),
    ("IN 0:02 -- OUT 0:03", "cue the whole turn"),
    ("IN 0:00 -- OUT 0:09", "cue the whole turn"),
    ("IN 0:09 -- OUT 0:02", "zero-length or reversed"),
    ("IN 0:05 -- OUT 0:05", "zero-length or reversed"),
    # Clock components that are not minutes and seconds.
    ("IN 0:02 -- OUT 0:69", "malformed cue"),
    ("IN 0:62 -- OUT 0:69", "malformed cue"),
    ("IN 0:02 -- OUT 0:09:75", "malformed cue"),
    ("IN 0:02 -- OUT 0:60:09", "malformed cue"),
    ("IN 0:02 -- OUT 0:9", "malformed cue"),
    # Not a complete header: something is glued on after a clock.
    ("IN 0:02 -- OUT 0:090", ("no [IN", "malformed")),
    ("IN 0:02 -- OUT 0:09.9", ("no [IN", "malformed")),
    ("IN 0:02 -- OUT 0:09garbage", ("no [IN", "malformed")),
    ("IN 0:02 -- OUT 0:09:00:00", ("no [IN", "malformed")),
    ("IN 0:020 -- OUT 0:09", ("no [IN", "malformed")),
    ("IN 0:02 -- OUT 0:09s", ("no [IN", "malformed")),
    ("IN " + "9" * 5000 + ":02 -- OUT 0:09", ("no [IN", "malformed")),
)


class QuoteCheckTests(unittest.TestCase):
    def setUp(self):
        self.turns = tape.transcript_turns(MESSAGES, CONTEXT_HEADER)

    def cued(self, cue):
        return tape.quote_problems(SCRIPT_OK.replace(CUE, cue), self.turns)

    def test_verbatim_quotes_pass_and_altered_quotes_are_repaired(self):
        self.assertEqual(tape.quote_problems(SCRIPT_OK, self.turns), [])
        self.assertEqual(bw.check(SCRIPT_OK, "sotvo", mode="new_script", turns=self.turns), [])
        problems = bw.check(SCRIPT_BAD, "sotvo", mode="new_script", turns=self.turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("not word-for-word", problems[0])

    def test_curly_quote_marks_do_not_dodge_the_check(self):
        curly = SCRIPT_BAD.replace('"THE BRIDGE', "“THE BRIDGE").replace("OTHER OPTION.\"", "OTHER OPTION.”")
        problems = tape.quote_problems(curly, self.turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("not word-for-word", problems[0])
        self.assertEqual(tape.quote_problems(curly.replace("OTHER OPTION", "CHOICE"), self.turns), [])

    def test_a_quote_stitched_from_two_turns_is_not_on_the_tape(self):
        stitched = SCRIPT_OK.replace("WE HAD NO CHOICE.", "WE HAD NO CHOICE. WHAT ABOUT THE SHOP OWNERS?")
        problems = tape.quote_problems(stitched, self.turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("not word-for-word", problems[0])

    def test_a_cue_for_a_different_turn_would_play_the_wrong_audio(self):
        problems = self.cued("IN 0:13 -- OUT 0:19")
        self.assertEqual(len(problems), 1)
        self.assertIn("play at IN 0:02 OUT 0:09", problems[0])
        # The same wiring reaches the writer's house-rule check.
        self.assertEqual(len(bw.check(SCRIPT_OK.replace(CUE, "IN 0:13 -- OUT 0:19"), "sotvo", mode="new_script", turns=self.turns)), 1)

    def test_a_tape_quote_with_no_cue_is_a_problem(self):
        bare = SCRIPT_OK.replace("[IN 0:02 -- OUT 0:09 | MAYOR BROWN]\n", "")
        problems = tape.quote_problems(bare, self.turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("no [IN", problems[0])

    def test_bad_cues_are_rejected_with_a_reason(self):
        for cue, fragments in BAD_CUES:
            with self.subTest(cue[:40]):
                problems = self.cued(cue)
                self.assertEqual(len(problems), 1)
                self.assertTrue(any(f in problems[0] for f in ((fragments,) if isinstance(fragments, str) else fragments)), problems[0])

    def test_good_cue_shapes_are_accepted(self):
        for cue in ("[IN 0:02 -- OUT 0:09 | MAYOR BROWN]", "[IN 0:02 -- OUT 0:09]", "[IN 0:02 – OUT 0:09|MAYOR BROWN, MAYOR]"):
            with self.subTest(cue):
                self.assertEqual(tape.quote_problems(SCRIPT_OK.replace("[IN 0:02 -- OUT 0:09 | MAYOR BROWN]", cue), self.turns), [])
        hour = [{**self.turns[1], "startMs": 3722000, "endMs": 3729000}]
        self.assertEqual(tape.quote_problems(SCRIPT_OK.replace(CUE, "IN 1:02:02 -- OUT 1:02:09"), hour), [])

    def test_each_sot_is_checked_against_its_own_cue(self):
        good_cue = "[IN 0:13 -- OUT 0:19 | MAYOR BROWN]\n"
        self.assertEqual(tape.quote_problems(SCRIPT_OK.replace(VO_LINE, SECOND_SOT % good_cue), self.turns), [])
        # The first SOT's cue does not cover a second clip.
        problems = tape.quote_problems(SCRIPT_OK.replace(VO_LINE, SECOND_SOT % ""), self.turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("no [IN", problems[0])
        self.assertIn("I'M SORRY", problems[0])
        # And a second clip cued with the first one's times is caught as the wrong audio.
        problems = tape.quote_problems(SCRIPT_OK.replace(VO_LINE, SECOND_SOT % f"[{CUE} | MAYOR BROWN]\n"), self.turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("play at IN 0:13 OUT 0:19", problems[0])

    def test_quote_must_match_on_word_boundaries(self):
        clipped = SCRIPT_OK.replace('"THE BRIDGE CLOSES MONDAY', '"HE BRIDGE CLOSES MONDAY')
        problems = tape.quote_problems(clipped, self.turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("HE BRIDGE CLOSES", problems[0])

    def test_quotes_outside_the_sot_are_not_checked_against_tape(self):
        with_release_quote = SCRIPT_OK.replace("IT SHUTS MONDAY FOR EIGHT MONTHS OF REPAIRS.",
                                               'THE CITY CALLS THE CLOSURE "AN UNAVOIDABLE SAFETY MEASURE FOR EVERY USER."')
        self.assertEqual(tape.quote_problems(with_release_quote, self.turns), [])
        self.assertEqual(tape.sot_segments(SCRIPT_OK),
                         ['\n[IN 0:02 -- OUT 0:09 | MAYOR BROWN]\n"THE BRIDGE CLOSES MONDAY AND IT STAYS CLOSED FOR EIGHT MONTHS. WE HAD NO CHOICE."\n'])
        self.assertEqual(tape.sot_segments("{ON CAM}\nNO CLIP HERE."), [])
        sot_only = SCRIPT_OK[SCRIPT_OK.index("{SOT}"):].split("{VO}")[0].strip()
        warning = '\n\nTAPE CHECK: NOT VERIFIED.\n- "These words are not in the tape."'
        self.assertEqual(tape.quote_problems(sot_only + warning, self.turns), [])

    def test_no_tape_means_no_quote_check(self):
        self.assertEqual(tape.quote_problems(SCRIPT_BAD, []), [])
        self.assertEqual(bw.check(SCRIPT_BAD, "sotvo", mode="new_script"), [])

    def test_tape_counts_as_material_and_reaches_the_writer_prompt(self):
        self.assertTrue(bw.has_material("/sotvo bridge", prior_answer=False, tape_attached=True))
        self.assertFalse(bw.has_material("/sotvo bridge", prior_answer=False))
        listing = tape.sot_listing(tape.pick_sots(self.turns))
        prompt = bw.writer_prompt("sotvo", tape_listing=listing)
        self.assertIn("verbatim tape", prompt)
        self.assertIn("IN 0:13 OUT 0:19", prompt)
        self.assertNotIn("IN 0:02", bw.writer_prompt("sotvo", mode="edit", tape_listing=listing, previous=SCRIPT_OK))


if __name__ == "__main__":
    unittest.main()
