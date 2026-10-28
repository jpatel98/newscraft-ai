import re
import unittest
from pathlib import Path

from newscraft_agent import public_events
from newscraft_agent.durable import normalized_events

SHARED = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "agent-contract.ts"


class PublicEventContractTests(unittest.TestCase):
    @unittest.skipUnless(SHARED.exists(), "shared package is not deployed with the worker")
    def test_python_mirror_matches_the_shared_typescript_contract(self):
        source = SHARED.read_text()
        version = int(re.search(r"AGENT_CONTRACT_VERSION = (\d+)", source).group(1))
        events_block = source.split("PUBLIC_AGENT_EVENTS = {", 1)[1].split("}", 1)[0]
        kinds_block = source.split("AGENT_TOOL_KIND_LABELS = {", 1)[1].split("} as const", 1)[0]
        self.assertEqual(version, public_events.AGENT_CONTRACT_VERSION)
        self.assertEqual(sorted(re.findall(r":\s*'([a-z_.]+)'", events_block)), sorted(public_events.PUBLIC_EVENTS))
        self.assertEqual(sorted(re.findall(r"^\t(\w+):", kinds_block, re.M)), sorted(public_events.TOOL_KIND_NAMES))

    def test_every_mapped_tool_kind_is_public(self):
        self.assertTrue(set(public_events.TOOL_KINDS.values()) <= set(public_events.TOOL_KIND_NAMES))
        self.assertEqual(public_events.tool_kind("browser_snapshot"), "browse")
        self.assertEqual(public_events.tool_kind("something_new"), "tool")

    def test_tool_progress_carries_its_public_kind(self):
        names, args, text = {}, {}, []
        start = normalized_events("TOOL_CALL_START", {"type": "TOOL_CALL_START", "toolCallId": "c1", "toolCallName": "web_extract"}, args, names, text)
        end = normalized_events("TOOL_CALL_END", {"type": "TOOL_CALL_END", "toolCallId": "c1"}, args, names, text)
        for event in (*start, *end):
            self.assertIn(event["event_type"], public_events.PUBLIC_EVENTS)
            self.assertEqual(event["data"]["kind"], "read")


if __name__ == "__main__":
    unittest.main()
