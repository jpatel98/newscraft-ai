from __future__ import annotations

import unittest

from hermes_chat.product_prompt import build_product_prompt


class PromptPathStabilityTests(unittest.TestCase):
    def test_owned_identity_uses_publication_tools_without_claiming_an_executor(self):
        prompt = build_product_prompt()
        self.assertIn("publish_markdown and publish_csv", prompt)
        self.assertNotIn("/workspace/outputs", prompt)
        self.assertIn("without executing model code", prompt)
        for host_detail in ("/Users/", "/runtime/tenants/", "hermes_home", "tenant-key", "agent.system_prompt"):
            self.assertNotIn(host_detail, prompt)
        self.assertEqual(prompt, build_product_prompt())


if __name__ == "__main__":
    unittest.main()
