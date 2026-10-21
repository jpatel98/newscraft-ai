import unittest

from hermes_chat import broadcast_writing as bw

KILAUEA = """WRITE suvo



NFORMATION PROVIDED BY USGS VOLCANOES:
After nearly two months since episode 54 of lava fountaining, episode 55 of Kilauea summit lava fountaining began at 3:19 a.m. HST this morning.
The lava fountain from the north vent reached an estimated 700 feet high above the vent around 5 a.m. Hawaii Standard Time.

SUPER:
Hawaii Volcanoes National Park, HIT
"""

SUVO_SCRIPT = """{SUVO}
[NAT SOUND UP AND UNDER]

HAWAII'S KILAUEA VOLCANO IS ERUPTING AGAIN AFTER NEARLY TWO MONTHS OF QUIET.

Super:
Hawaii Volcanoes National Park, HI

Banner:
Hawaii's Kilauea volcano erupts again"""


class DetectTests(unittest.TestCase):
    def test_named_formats_in_the_opening_line(self):
        self.assertEqual(bw.detect(KILAUEA), "suvo")
        self.assertEqual(bw.detect("Write OCVO\n\nThe Bank of Canada has held its key rate."), "ocvo")
        self.assertEqual(bw.detect("Write a 30-second OC/VO from this answer."), "ocvo")
        self.assertEqual(bw.detect("give me an ocvo sotvo on the rally"), "sotvo")
        self.assertEqual(bw.detect("DVE VO please: two subway stations renamed"), "dve")
        self.assertEqual(bw.detect("draft a tease for the zoo hippo story"), "tease")
        self.assertEqual(bw.detect("write me a live throw to Sean in St. Catharines"), "intro")
        self.assertEqual(bw.detect("write a headline for the Crosstown opening"), "headline")
        self.assertEqual(bw.detect("give me three banners for this"), "banner")

    def test_slash_shortcuts(self):
        self.assertEqual(bw.detect("/ocvo The Bank of Canada has held"), "ocvo")
        self.assertEqual(bw.detect("/SUVO\nUSGS says"), "suvo")
        self.assertEqual(bw.detect("/top_of_show tonight's lead"), "intro")
        self.assertEqual(bw.strip_slash("/ocvo  The Bank"), "The Bank")
        self.assertIsNone(bw.slash_format("/feedback this is slow"))

    def test_ordinary_requests_are_not_scripts(self):
        for request in ("What are today's top headlines in Toronto?", "Find the latest on the TTC strike",
                        "Who is the intro speaker at the gala?", "Suvorov biography", "summarize the banner ads report"):
            self.assertIsNone(bw.detect(request), request)

    def test_the_one_click_script_action_is_an_ocvo(self):
        self.assertEqual(bw.detect("anything", output_action="thirty_second_script"), "ocvo")

    def test_a_short_note_after_a_script_revises_it(self):
        self.assertEqual(bw.detect("WE WANT THE 25K NUMBER", last_answer=SUVO_SCRIPT), "suvo")
        self.assertEqual(bw.detect("U R WRITIN FOR CANADIAN AUDIENCE, KEEP IT SHORT", last_answer=SUVO_SCRIPT), "suvo")
        self.assertTrue(bw.is_revision("shorter", "suvo", SUVO_SCRIPT))
        self.assertFalse(bw.is_revision("/suvo new copy", "suvo", SUVO_SCRIPT))
        # A new question is a new request, and a note without a script before it is not a script turn.
        self.assertIsNone(bw.detect("What's the latest on the TTC strike?", last_answer=SUVO_SCRIPT))
        self.assertIsNone(bw.detect("shorter", last_answer="The Bank of Canada decides next week. [1]"))
        self.assertIsNone(bw.detect("x" * 700, last_answer=SUVO_SCRIPT))

    def test_script_format_reads_cues(self):
        self.assertEqual(bw.script_format("{ON CAM}\nA LINE.\n\n{VO}\nMORE."), "ocvo")
        self.assertEqual(bw.script_format("{VO}\nMORE.\n{SOT}\n[CLIP]\n{VO}\nEND."), "sotvo")
        self.assertEqual(bw.script_format("{VO}\nA TINY NEW ARRIVAL...\nA FIRST LOOK -- JUST AHEAD."), "tease")
        self.assertEqual(bw.script_format("{VO}\nA PEDESTRIAN IS DEAD."), "dve")
        self.assertEqual(bw.script_format("(AR OC)\nGOOD EVENING."), "intro")
        self.assertIsNone(bw.script_format("Plain answer text."))


class SkillTests(unittest.TestCase):
    def test_material_comes_from_pasted_copy_or_the_thread(self):
        self.assertTrue(bw.has_material(KILAUEA, prior_answer=False))
        self.assertFalse(bw.has_material("/ocvo Bank of Canada rate decision", prior_answer=False))
        self.assertTrue(bw.has_material("/ocvo", prior_answer=True))

    def test_every_format_loads_the_shared_rules_and_its_guide(self):
        for fmt in bw.FORMATS:
            text = bw.instructions(fmt)
            self.assertIn("Accuracy comes first", text)
            self.assertIn("25-THOUSAND", text)
        self.assertIn("[NAT SOUND UP AND UNDER]", bw.instructions("suvo"))
        with self.assertRaises(ValueError):
            bw.instructions("pkg")

    def test_writer_prompt(self):
        prompt = bw.writer_prompt("suvo", revision=False)
        self.assertIn("Write the SUVO now", prompt)
        self.assertNotIn("Sources:", prompt)
        self.assertIn("full revised script", bw.writer_prompt("suvo", revision=True))
        self.assertIn("Sources: [n] [m]", bw.writer_prompt("ocvo", revision=False, sources_line=True))
        self.assertIn("paste the source copy", bw.writer_prompt("ocvo", revision=False, material=False))
        pages = [{"number": 1}]
        self.assertIn("SOURCE TEXT", bw.writer_prompt("ocvo", revision=False, pages=pages, page_listing="[1] SOURCE TEXT"))


if __name__ == "__main__":
    unittest.main()
