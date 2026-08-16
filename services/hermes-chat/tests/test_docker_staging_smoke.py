from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from docker_staging_smoke import _assert_tool_success, _json_from_tool_text


class DockerStagingSmokeTests(unittest.TestCase):
    def test_unwraps_hermes_untrusted_tool_result_envelope(self) -> None:
        text = (
            'STAGING_TOOL_RESULT <untrusted_tool_result source="browser_navigate">\n'
            '{"success":true,"url":"https://example.com/"}\n'
            "</untrusted_tool_result>"
        )

        self.assertEqual(_json_from_tool_text(text)["success"], True)
        _assert_tool_success(text, "browser navigation")

    def test_tool_success_rejects_a_wrapped_error(self) -> None:
        text = (
            "STAGING_TOOL_RESULT <untrusted_tool_result>\n"
            '{"success":false,"error":"blocked"}\n'
            "</untrusted_tool_result>"
        )

        with self.assertRaises(RuntimeError):
            _assert_tool_success(text, "browser navigation")

    def test_finds_a_success_object_when_the_stream_concatenates_arguments(self) -> None:
        text = (
            '{"url":"https://example.com/"}'
            '<untrusted_tool_result source="browser_navigate">'
            '{"success":true,"url":"https://example.com/"}'
            "</untrusted_tool_result>"
        )

        _assert_tool_success(text, "browser navigation")


if __name__ == "__main__":
    unittest.main()
