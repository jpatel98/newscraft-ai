from __future__ import annotations

import contextlib
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from hermes_chat.isolation import TenantIsolation, tenant_run_scope
from hermes_chat.product_prompt import (
    NEWSCRAFT_IDENTITY_MARKER,
    NEWSCRAFT_PRODUCT_IDENTITY,
    NEWSCRAFT_RUNTIME_IDENTITY_POINTER,
    append_product_identity,
    tenant_preferences_only,
)
from hermes_chat.service import _install_product_identity_scope, _install_tenant_builder


UPSTREAM_IDENTITY = (
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful, "
    "knowledgeable, and direct."
)


class ProductPromptTests(unittest.TestCase):
    def test_product_identity_is_one_authoritative_final_layer(self) -> None:
        tenant_soul = f"{UPSTREAM_IDENTITY}\n\nUse concise bullets for routine work."
        tenant_preferences = tenant_preferences_only(tenant_soul, UPSTREAM_IDENTITY)
        standard_cached_prompt = "\n\n".join(
            [
                "Standard Hermes tool guidance: use the available runtime tools.",
                "Standard Hermes memory guidance: use tenant-local MEMORY.md and USER.md.",
                "Standard Hermes skills guidance: use the available skills index.",
                tenant_preferences or "",
                "Thread override: return a short table when the task allows it.",
            ]
        )

        effective_prompt = append_product_identity(standard_cached_prompt)

        self.assertEqual(effective_prompt.count(NEWSCRAFT_IDENTITY_MARKER), 1)
        self.assertNotIn(UPSTREAM_IDENTITY, effective_prompt)
        self.assertIn("Standard Hermes tool guidance", effective_prompt)
        self.assertIn("tenant-local MEMORY.md", effective_prompt)
        self.assertIn("Standard Hermes skills guidance", effective_prompt)
        self.assertIn("Thread override: return a short table", effective_prompt)
        self.assertLess(
            effective_prompt.index("Thread override: return a short table"),
            effective_prompt.index(NEWSCRAFT_IDENTITY_MARKER),
        )
        self.assertEqual(append_product_identity(effective_prompt), effective_prompt)

    def test_identity_contains_editorial_freshness_and_citation_contract(self) -> None:
        prompt = NEWSCRAFT_PRODUCT_IDENTITY
        required_phrases = (
            "genuinely new developments",
            "still developing",
            "older context",
            "few genuinely new items",
            "do not infer a fixed item count",
            "publication or update time",
            "Access time alone does not prove freshness",
            "archive copy",
            "verified fact, allegation, analysis, and inference",
            "latest-turn authority",
            "claim-level provenance",
            "clear claim group or paragraph",
            "source map complete and resolvable",
            "greetings, simple transformations",
            "credentials",
            "Do not narrate plans",
            "one clean answer",
            "headings only when they match real content sections",
        )
        for phrase in required_phrases:
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, prompt)
        self.assertNotRegex(prompt, re.compile(r"\b(?:exactly|at least|top)\s+\d+\s+(?:stories|items)\b", re.I))
        self.assertNotIn("next to every factual claim", prompt.lower())

    def test_tenant_memory_prompt_inputs_remain_separate(self) -> None:
        tenant_a = append_product_identity("Tenant A memory: harbour assignment.")
        tenant_b = append_product_identity("Tenant B memory: court assignment.")

        self.assertIn("Tenant A memory", tenant_a)
        self.assertNotIn("Tenant B memory", tenant_a)
        self.assertIn("Tenant B memory", tenant_b)
        self.assertNotIn("Tenant A memory", tenant_b)

    def test_prompt_scope_neutralizes_conflicting_generic_identity(self) -> None:
        agent_module = ModuleType("agent")
        agent_module.__path__ = []  # type: ignore[attr-defined]
        run_agent = ModuleType("run_agent")
        run_agent.DEFAULT_AGENT_IDENTITY = UPSTREAM_IDENTITY
        run_agent.load_soul_md = lambda *_args, **_kwargs: (
            f"{UPSTREAM_IDENTITY}\n\nTenant preference: use concise bullets."
        )
        prompt_builder = ModuleType("agent.prompt_builder")
        prompt_builder.DEFAULT_AGENT_IDENTITY = UPSTREAM_IDENTITY
        system_prompt = ModuleType("agent.system_prompt")
        system_prompt.DEFAULT_AGENT_IDENTITY = UPSTREAM_IDENTITY

        with patch.dict(
            sys.modules,
            {
                "agent": agent_module,
                "agent.prompt_builder": prompt_builder,
                "agent.system_prompt": system_prompt,
                "run_agent": run_agent,
            },
        ):
            _install_product_identity_scope()
            _install_product_identity_scope()
            self.assertEqual(run_agent.load_soul_md(), f"{UPSTREAM_IDENTITY}\n\nTenant preference: use concise bullets.")
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                runtime = TenantIsolation(root / "home", root / "workspace").resolve("tenant-prompt")
                with tenant_run_scope(
                    runtime,
                    thread_id="thread",
                    run_id="run",
                    home_override=contextlib.nullcontext(),
                    session_scope=contextlib.nullcontext(),
                ):
                    scoped_soul = run_agent.load_soul_md()

        self.assertIsNotNone(scoped_soul)
        self.assertNotIn(UPSTREAM_IDENTITY, scoped_soul or "")
        self.assertIn("Tenant preference: use concise bullets.", scoped_soul or "")
        self.assertEqual(prompt_builder.DEFAULT_AGENT_IDENTITY, NEWSCRAFT_RUNTIME_IDENTITY_POINTER)
        self.assertEqual(system_prompt.DEFAULT_AGENT_IDENTITY, NEWSCRAFT_RUNTIME_IDENTITY_POINTER)

    def test_tenant_builder_preserves_standard_agent_and_adds_identity_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime = TenantIsolation(root / "home", root / "workspace").resolve(
                "tenant-product-prompt"
            )
            agent = SimpleNamespace(ephemeral_system_prompt="Thread override remains available.")
            agui_server = SimpleNamespace(build_run_agent=lambda **_kwargs: agent)

            _install_tenant_builder(agui_server)
            with tenant_run_scope(
                runtime,
                thread_id="thread",
                run_id="run",
                home_override=lambda _path: contextlib.nullcontext(),
                session_scope=lambda _run: contextlib.nullcontext(),
            ):
                built = agui_server.build_run_agent(cwd="/host/workspace")

        self.assertIs(built, agent)
        self.assertTrue(agent.load_soul_identity)
        self.assertEqual(agent.ephemeral_system_prompt.count(NEWSCRAFT_IDENTITY_MARKER), 1)
        self.assertIn("Thread override remains available", agent.ephemeral_system_prompt)


class NewsroomFixtureTests(unittest.TestCase):
    def test_broad_latest_news_fixture_groups_fresh_items_without_stale_padding(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "latest_news_compaction.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        answer = fixture["model_output"]
        sources = {source["citation"]: source for source in fixture["sources"]}

        self.assertIn("## Genuinely new developments", answer)
        self.assertIn("## Still developing", answer)
        self.assertEqual(sources["1"]["freshness"], "new")
        self.assertEqual(sources["2"]["freshness"], "developing")
        self.assertEqual(sources["3"]["freshness"], "older")
        self.assertNotIn("[3]", answer)
        self.assertNotIn("older context", answer.lower())

        citations = re.findall(r"\[(\d+)\]", answer)
        self.assertEqual(citations, ["1", "2"])
        paragraphs = [paragraph for paragraph in answer.split("\n\n") if paragraph.strip()]
        first_cited_paragraph = next(paragraph for paragraph in paragraphs if "[1]" in paragraph)
        self.assertGreaterEqual(first_cited_paragraph.count("."), 2)
        self.assertEqual(first_cited_paragraph.count("[1]"), 1)
        self.assertEqual(
            {citation for citation in citations},
            {"1", "2"},
            "a source change must use a distinct marker",
        )

    def test_jig_188_regressions_are_covered_by_the_hermes_evaluation_set(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "jig_188_quality_regressions.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        cases = fixture["cases"]

        expected_ids = {
            "transit-publication-date",
            "compact-gas-price-answer",
            "aomori-rejected-candidate",
        }
        self.assertEqual({case["id"] for case in cases}, expected_ids)

        for case in cases:
            with self.subTest(case=case["id"]):
                answer = case["model_output"]
                for phrase in case["must_contain"]:
                    self.assertIn(phrase, answer)
                for phrase in case["must_not_contain"]:
                    self.assertNotIn(phrase, answer)

                accepted_citations = [
                    source["citation"]
                    for source in case["sources"]
                    if source["evidence_status"] == "accepted"
                ]
                self.assertEqual(re.findall(r"\[(\d+)\]", answer), accepted_citations)

                for source in case["sources"]:
                    if source["evidence_status"] == "rejected":
                        self.assertNotIn(f"[{source['citation']}]", answer)
                    if source.get("publication_at") and source.get("retrieval_time"):
                        self.assertNotEqual(source["publication_at"], source["retrieval_time"])
                        self.assertNotIn(source["retrieval_time"], answer)


if __name__ == "__main__":
    unittest.main()
