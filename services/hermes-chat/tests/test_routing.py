import unittest

from hermes_chat.portable import ROUTE_CHAT, ROUTE_DELIVERABLE, ROUTE_LOOP, ROUTE_QUICK, choose_route, fresh_turn


def state(**overrides):
    return {"intent": None, "pending": [], "steps": 0, "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}], **overrides}


class RouterTests(unittest.TestCase):
    def test_a_plain_question_takes_the_quick_path(self):
        self.assertEqual(choose_route(True, "Any TTC closures this weekend?", has_page_search=True), ROUTE_QUICK)
        self.assertEqual(choose_route(True, "Any TTC closures this weekend?", has_page_search=False), ROUTE_QUICK)

    def test_a_file_request_is_researched_first_only_with_page_search(self):
        self.assertEqual(choose_route(True, "Make a CSV of closures", has_page_search=True), ROUTE_DELIVERABLE)
        self.assertEqual(choose_route(True, "Make a CSV of closures", has_page_search=False), ROUTE_LOOP)

    def test_small_talk_skips_research_only_on_a_fresh_turn(self):
        self.assertEqual(choose_route(True, "yoo", has_page_search=True, small_talk=True), ROUTE_CHAT)
        self.assertEqual(choose_route(False, "yoo", has_page_search=True, small_talk=True), ROUTE_LOOP)
        self.assertEqual(choose_route(True, "yoo", has_page_search=True), ROUTE_QUICK)

    def test_started_turns_images_and_computers_go_to_the_loop(self):
        self.assertTrue(fresh_turn(state(), has_computer=False))
        self.assertFalse(fresh_turn(state(steps=1), has_computer=False))
        self.assertFalse(fresh_turn(state(fast="started"), has_computer=False))
        self.assertFalse(fresh_turn(state(), has_computer=True))
        image = state(messages=[{"role": "user", "content": [{"type": "image", "media_type": "image/png", "data": ""}]}])
        self.assertFalse(fresh_turn(image, has_computer=False))
        self.assertEqual(choose_route(False, "Any TTC closures?", has_page_search=True), ROUTE_LOOP)
        self.assertEqual(choose_route(True, "", has_page_search=True), ROUTE_LOOP)


if __name__ == "__main__":
    unittest.main()
