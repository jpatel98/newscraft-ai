import unittest

from newscraft_agent import broadcast_writing as bw

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


class RouteTests(unittest.TestCase):
    def test_explicit_intent_needs_no_model(self):
        self.assertEqual(bw.route(KILAUEA), {"intent": "new_script", "format": "suvo"})
        self.assertEqual(bw.route("Write OCVO\n\n" + "The Bank of Canada has held its key rate for about a year. " * 4)["format"], "ocvo")
        self.assertEqual(bw.route("/ocvo The Bank of Canada has held"), {"intent": "new_script", "format": "ocvo"})
        self.assertEqual(bw.route("/top_of_show tonight's lead")["format"], "intro")
        self.assertEqual(bw.route("anything", output_action="thirty_second_script"), {"intent": "new_script", "format": "ocvo"})

    def test_follow_ups_and_bare_format_mentions_go_to_the_classifier(self):
        for request in ("should it not be in the code that runs most of the internet?", "WE WANT THE 25K NUMBER",
                        "What's the latest on the TTC strike?"):
            self.assertEqual(bw.route(request, last_answer=SUVO_SCRIPT), {"intent": "classify", "format": "suvo", "previous": "suvo"})
        self.assertEqual(bw.route("make it a DVE", last_answer=SUVO_SCRIPT)["format"], "dve")
        self.assertEqual(bw.route("write a headline for the Crosstown opening"), {"intent": "classify", "format": "headline", "previous": None})
        self.assertEqual(bw.route("what does OCVO mean?")["intent"], "classify")

    def test_ordinary_requests_never_touch_the_skill(self):
        for request in ("What are today's top headlines in Toronto?", "Find the latest on the TTC strike",
                        "Who is the intro speaker at the gala?", "Suvorov biography", "summarize the banner ads report"):
            self.assertIsNone(bw.route(request, last_answer="The Bank of Canada decides next week. [1]"), request)

    def test_named_formats(self):
        self.assertEqual(bw.named_format("Write a 30-second OC/VO from this answer."), "ocvo")
        self.assertEqual(bw.named_format("give me an ocvo sotvo on the rally"), "sotvo")
        self.assertEqual(bw.named_format("DVE VO please: two subway stations renamed"), "dve")
        self.assertEqual(bw.named_format("draft a tease for the zoo hippo story"), "tease")
        self.assertEqual(bw.named_format("write a suvo tease\nClip from the fire chief"), "tease")
        self.assertEqual(bw.named_format("write me a live throw to Sean in St. Catharines"), "intro")
        self.assertEqual(bw.named_format("give me three banners for this"), "banner")
        self.assertIsNone(bw.named_format("What are today's top headlines in Toronto?"))
        self.assertEqual(bw.strip_slash("/ocvo  The Bank"), "The Bank")
        self.assertIsNone(bw.slash_format("/feedback this is slow"))

    def test_classifier_prompt_and_parsing(self):
        prompt = bw.classifier_prompt("should it not be the code?", SUVO_SCRIPT)
        self.assertIn("SUVO script", prompt)
        self.assertIn("should it not be the code?", prompt)
        edit = '{"intent": "edit", "format": "banner", "research": false}'
        # An edit keeps the last script's format unless the note names another one.
        self.assertEqual(bw.parse_intent(edit, "suvo", request="banner is too long", previous="suvo"),
                         {"intent": "edit", "format": "suvo", "research": False})
        self.assertEqual(bw.parse_intent(edit, "suvo", request="make it a DVE", previous="suvo")["format"], "dve")
        # With no script before it, an edit is a new script and a question is not a script turn.
        self.assertEqual(bw.parse_intent(edit, "banner", request="give me banners")["intent"], "new_script")
        self.assertEqual(bw.parse_intent('{"intent": "question", "format": "ocvo"}', "ocvo")["intent"], "other")
        self.assertEqual(bw.parse_intent('Sure: {"intent": "new_script", "format": null}', "ocvo")["format"], "ocvo")
        self.assertEqual(bw.parse_intent('{"intent": "other", "format": null}', "ocvo"), {"intent": "other", "format": None, "research": False})
        self.assertFalse(bw.parse_intent('{"intent": "edit", "format": "suvo", "research": true}', "suvo", previous="suvo")["research"])
        self.assertIsNone(bw.parse_intent("not json", "ocvo"))
        self.assertIsNone(bw.parse_intent('{"intent": "rewrite"}', "ocvo"))

    def test_measurable_house_rules(self):
        bad = "{ON CAM}\nA fire burned 500 ACRES.\n{VO}\nFORTY-TWO HUNDRED PEOPLE LEFT [1].\n\nBanner:\nFire"
        problems = " ".join(bw.check(bad, "ocvo", mode="new_script"))
        for expected in ("upper case", "Citation markers", "FORTY", "ACRES"):
            self.assertIn(expected, problems)
        self.assertEqual(bw.check(SUVO_SCRIPT, "suvo", mode="new_script"), [])
        self.assertEqual(bw.check("Because house style drops it.", "suvo", mode="question"), [])
        # An edit may keep a unit the note asks for, but not bring back another.
        kept = SUVO_SCRIPT.replace("AGAIN", "AGAIN... 48-THOUSAND ACRES... 45 MILES AN HOUR")
        self.assertIn("MILES", " ".join(bw.check(kept, "suvo", mode="edit", request="keep the acres", previous=SUVO_SCRIPT)))
        self.assertNotIn("ACRES,", " ".join(bw.check(kept, "suvo", mode="edit", request="keep the acres", previous=SUVO_SCRIPT)))
        self.assertIn("house rules", bw.repair_prompt(["x"]))

    def test_keyword_fallback_only_when_the_classifier_fails(self):
        decision = bw.route("should it not be the code?", last_answer=SUVO_SCRIPT)
        self.assertEqual(bw.fallback_intent("should it not be the code?", decision)["intent"], "edit")
        self.assertEqual(bw.fallback_intent("write a headline", {"previous": None})["research"], True)

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

    def test_spoken_words_skip_cues_notes_and_lower_thirds(self):
        self.assertEqual(bw.spoken_words(SUVO_SCRIPT), 12)

    def test_writer_prompt(self):
        prompt = bw.writer_prompt("suvo")
        self.assertIn("Write the SUVO now", prompt)
        self.assertNotIn("Sources:", prompt)
        self.assertIn("full revised script", bw.writer_prompt("suvo", mode="edit"))
        self.assertIn("at most 80 spoken words", bw.writer_prompt("ocvo", mode="new_script"))
        self.assertIn("has 12 spoken words", bw.writer_prompt("suvo", mode="edit", previous=SUVO_SCRIPT))
        self.assertIn("Sources: [n] [m]", bw.writer_prompt("ocvo", mode="new_script", sources_line=True))
        self.assertIn("paste the source copy", bw.writer_prompt("ocvo", mode="new_script", material=False))
        self.assertIn("Do not rewrite or repeat the script", bw.writer_prompt("suvo", mode="question"))
        self.assertIn("treat it as the change it proposes", bw.writer_prompt("suvo", mode="edit"))
        pages = [{"number": 1}]
        self.assertIn("SOURCE TEXT", bw.writer_prompt("ocvo", mode="new_script", pages=pages, page_listing="[1] SOURCE TEXT"))


if __name__ == "__main__":
    unittest.main()
