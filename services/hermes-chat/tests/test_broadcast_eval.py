"""Replays the recorded broadcast-writing eval (eval/broadcast): routing and house-rule checks, no network.

A change to the skill files or prompts changes the prompt hashes, so this fails until the cassette is re-recorded with
`python services/hermes-chat/scripts/broadcast_eval.py --record` and the new scores are reviewed."""
import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "broadcast_eval.py"
spec = importlib.util.spec_from_file_location("broadcast_eval", SCRIPT)
broadcast_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broadcast_eval)


class BroadcastEvalReplay(unittest.TestCase):
    def test_recorded_eval_passes(self):
        report = broadcast_eval.evaluate(record=False)
        self.assertEqual(report["routing"]["failures"], [])
        self.assertEqual(report["writing"]["failures"], [])
        self.assertEqual(report["routing"]["total"], 40)


if __name__ == "__main__":
    unittest.main()
