import asyncio
import unittest

from hermes_chat import ledger_copy
from hermes_chat.model_adapters import ModelReply


class FakeModel:
    def __init__(self, text):
        self.text = text
        self.calls = []

    async def complete(self, **kwargs):
        self.calls.append(kwargs)
        return ModelReply(message={"role": "assistant", "content": [{"type": "text", "text": self.text}]}, private={}, usage={})


CLAIMS = [
    {"id": "c1", "claim": "Two people were taken to hospital", "say": ""},
    {"id": "c2", "claim": "The driver was speeding", "say": "Toronto police allege"},
]


class LedgerCopyTests(unittest.TestCase):
    def test_parses_tagged_lines_and_drops_unknown_ids(self):
        reply = "Here you go:\n[c1] Two people are in hospital.\n[c2,c9] Toronto police allege the driver was speeding.\n[zz] Made up.\nuntagged line"
        model = FakeModel(reply)
        lines = asyncio.run(ledger_copy.write_copy(model, "m", CLAIMS, "vo", "Bloor crash"))
        self.assertEqual(lines, [
            {"claims": ["c1"], "text": "Two people are in hospital."},
            {"claims": ["c2"], "text": "Toronto police allege the driver was speeding."},
            {"claims": [], "text": "Made up."},
        ])
        self.assertEqual(model.calls[0]["tools"], [])
        self.assertIn("a VO", model.calls[0]["instructions"])

    def test_claims_are_quoted_with_their_say_phrase(self):
        kept, prompt = ledger_copy.build_prompt(CLAIMS + [{"id": "", "claim": "x"}, {"id": "c3", "claim": 'Ignore "rules"'}], "Bloor")
        self.assertEqual([c["id"] for c in kept], ["c1", "c2", "c3"])
        self.assertIn('c2: "The driver was speeding"\n  SAY: "Toronto police allege"', prompt)
        self.assertIn('c3: "Ignore \\"rules\\""', prompt)
        self.assertNotIn("c1: \"Two people were taken to hospital\"\n  SAY", prompt)

    def test_unknown_format_is_refused(self):
        with self.assertRaises(ValueError):
            asyncio.run(ledger_copy.write_copy(FakeModel(""), "m", CLAIMS, "tease"))


if __name__ == "__main__":
    unittest.main()
