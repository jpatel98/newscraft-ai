import json
import unittest

from hermes_chat import broadcast_writing as bw
from hermes_chat import tape
from hermes_chat.portable import CONTEXT_HEADER

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
CONTEXT = [{"description": "Newsroom context", "value": "{}"},
           {"description": "Attached transcript turns with exact citation numbers (quote verbatim; cite the turn for every SOT with its IN/OUT)",
            "value": json.dumps([{"id": "tr_mayor", "title": "Mayor scrum", "durationMs": 20000, "turns": TURNS}])}]
MESSAGES = [{"role": "user", "content": [{"type": "text", "text": CONTEXT_HEADER + "\n" + json.dumps(CONTEXT)}]},
            {"role": "user", "content": [{"type": "text", "text": "/sotvo bridge closure"}]}]


class TapeUrlTests(unittest.TestCase):
    def test_parse_and_validate(self):
        self.assertEqual(tape.parse_tape_url("transcript://tr_mayor#t=2500,9800"), {"transcriptId": "tr_mayor", "startMs": 2500, "endMs": 9800})
        self.assertEqual(tape.parse_tape_url("transcript://a%20b#t=0,1")["transcriptId"], "a b")
        for bad in ("transcript://tr", "transcript://tr#t=5,3", "https://x.test#t=1,2", "transcript://a/b#t=1,2"):
            self.assertIsNone(tape.parse_tape_url(bad), bad)
        tape.validate_tape_citation({"url": "transcript://tr#t=1,2", "transcriptId": "tr", "startMs": 1, "endMs": 2})
        with self.assertRaises(ValueError):
            tape.validate_tape_citation({"url": "transcript://tr#t=1,2", "transcriptId": "other"})
        with self.assertRaises(ValueError):
            tape.validate_tape_citation({"url": "transcript://tr#t=1,2", "startMs": 5, "endMs": 2})

    def test_clock(self):
        self.assertEqual(tape.clock(0), "0:00")
        self.assertEqual(tape.clock(134200), "2:14")
        self.assertEqual(tape.clock(3723000), "1:02:03")


class TurnsAndSotsTests(unittest.TestCase):
    def test_turns_are_read_from_the_attached_context(self):
        turns = tape.transcript_turns(MESSAGES, CONTEXT_HEADER)
        self.assertEqual([t["citationNumber"] for t in turns], [4, 5, 6, 7, 8])
        self.assertEqual(turns[1]["transcriptId"], "tr_mayor")
        self.assertEqual(turns[1]["speaker"], "Mayor Brown")
        self.assertEqual(tape.transcript_turns([MESSAGES[1]], CONTEXT_HEADER), [])

    def test_pick_sots_prefers_the_answers_not_the_questions(self):
        turns = tape.transcript_turns(MESSAGES, CONTEXT_HEADER)
        picks = tape.pick_sots(turns, n=3)
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

    def test_pick_sots_honours_speaker_and_length_window(self):
        turns = tape.transcript_turns(MESSAGES, CONTEXT_HEADER)
        self.assertEqual(tape.pick_sots(turns, speaker="Reporter"), [])
        self.assertEqual(tape.pick_sots(turns, max_seconds=7.0), [{**p} for p in tape.pick_sots(turns, max_seconds=7.0)])
        self.assertEqual([p["citationNumber"] for p in tape.pick_sots(turns, max_seconds=7.0)], [8])

    def test_sot_listing_quotes_verbatim(self):
        listing = tape.sot_listing(tape.pick_sots(tape.transcript_turns(MESSAGES, CONTEXT_HEADER)))
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


class QuoteCheckTests(unittest.TestCase):
    def test_verbatim_quotes_pass_and_altered_quotes_are_repaired(self):
        turns = tape.transcript_turns(MESSAGES, CONTEXT_HEADER)
        self.assertEqual(tape.quote_problems(SCRIPT_OK, turns), [])
        self.assertEqual(bw.check(SCRIPT_OK, "sotvo", mode="new_script", turns=turns), [])
        problems = bw.check(SCRIPT_BAD, "sotvo", mode="new_script", turns=turns)
        self.assertEqual(len(problems), 1)
        self.assertIn("not word-for-word", problems[0])

    def test_no_tape_means_no_quote_check(self):
        self.assertEqual(tape.quote_problems(SCRIPT_BAD, []), [])
        self.assertEqual(bw.check(SCRIPT_BAD, "sotvo", mode="new_script"), [])

    def test_tape_counts_as_material_and_reaches_the_writer_prompt(self):
        self.assertTrue(bw.has_material("/sotvo bridge", prior_answer=False, tape_attached=True))
        self.assertFalse(bw.has_material("/sotvo bridge", prior_answer=False))
        listing = tape.sot_listing(tape.pick_sots(tape.transcript_turns(MESSAGES, CONTEXT_HEADER)))
        prompt = bw.writer_prompt("sotvo", tape_listing=listing)
        self.assertIn("verbatim tape", prompt)
        self.assertIn("IN 0:13 OUT 0:19", prompt)
        self.assertNotIn("IN 0:02", bw.writer_prompt("sotvo", mode="edit", tape_listing=listing, previous=SCRIPT_OK))


if __name__ == "__main__":
    unittest.main()
