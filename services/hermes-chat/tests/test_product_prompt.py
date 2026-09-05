from __future__ import annotations

import contextlib
import json
import re
import sys
import tempfile
import unittest
from copy import deepcopy
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


def citation_numbers(text: str) -> set[int]:
    return {int(number) for number in re.findall(r"\[(\d+)\]", text)}


def citation_support_score(fixture: dict[str, object]) -> dict[str, object]:
    """Score fixture-declared claim-to-source mappings without judging prose."""
    sources = fixture["sources"]
    paragraphs = fixture["paragraphs"]
    claims = fixture["expected_material_claims"]
    source_by_citation = {
        source["citation_number"]: source["id"]
        for source in sources
    }
    paragraph_by_id = {paragraph["id"]: paragraph["text"] for paragraph in paragraphs}
    evaluations = []
    for claim in claims:
        cited_numbers = citation_numbers(paragraph_by_id[claim["paragraph_id"]])
        allowed_numbers = set(claim["allowed_citation_numbers"])
        allowed_source_ids = set(claim["allowed_source_ids"])
        supported = any(
            citation in allowed_numbers
            and source_by_citation.get(citation) in allowed_source_ids
            for citation in cited_numbers
        )
        evaluations.append({"id": claim["id"], "supported": supported})

    passed = sum(1 for evaluation in evaluations if evaluation["supported"])
    total = len(evaluations)
    return {
        "passed": passed,
        "total": total,
        "ratio": passed / total if total else 1.0,
        "claims": evaluations,
    }


JIG_189_RUBRIC_DIMENSIONS = (
    "task_completion",
    "currentness",
    "source_quality",
    "citation_support",
    "caveats",
    "format",
    "newsroom_usefulness",
)
JIG_189_REQUIRED_CATEGORIES = frozenset(
    {
        "breaking_news_update",
        "source_comparison",
        "fact_check",
        "producer_brief",
        "live_hit_notes",
        "vo",
        "intro",
        "tease",
        "banner",
        "interview_questions",
        "document_grounded",
        "follow_up",
        "correction",
        "conflicting_sources",
        "blocked_sources",
        "stale_sources",
    }
)
JIG_189_SOURCE_QUALITIES = frozenset(
    {"official", "direct", "secondary", "document", "mixed", "blocked", "stale"}
)
JIG_189_CURRENTNESS_STATES = frozenset(
    {"current", "historical_context", "conflict", "blocked", "stale_rejected"}
)
JIG_189_OUTCOMES = frozenset({"success", "expected_failure"})
JIG_189_FORBIDDEN_PROSE_FIELDS = frozenset(
    {"answer", "model_output", "expected_answer", "exact_answer"}
)


def _jig_189_error(errors: list[str], workflow_id: str, dimension: str, detail: str) -> None:
    errors.append(f"{workflow_id}: {dimension} failed: {detail}")


def _jig_189_pairs(
    entries: object,
    *,
    workflow_id: str,
    dimension: str,
    errors: list[str],
    source_by_id: dict[str, dict[str, object]],
    require_required_flag: bool = False,
) -> list[tuple[str, int]]:
    if not isinstance(entries, list):
        _jig_189_error(errors, workflow_id, dimension, "expected a list of citation mappings")
        return []

    pairs: list[tuple[str, int]] = []
    citation_numbers: set[int] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            _jig_189_error(errors, workflow_id, dimension, f"mapping {index} is not an object")
            continue
        source_id = entry.get("source_id")
        citation_number = entry.get("citation_number")
        if not isinstance(source_id, str) or not source_id:
            _jig_189_error(errors, workflow_id, dimension, f"mapping {index} has no source_id")
            continue
        if not isinstance(citation_number, int) or isinstance(citation_number, bool) or citation_number < 1:
            _jig_189_error(errors, workflow_id, dimension, f"mapping {index} has an invalid citation number")
            continue
        if source_id not in source_by_id:
            _jig_189_error(errors, workflow_id, dimension, f"mapping {index} names unknown source {source_id}")
        elif source_by_id[source_id].get("evidence_status") != "accepted":
            _jig_189_error(errors, workflow_id, dimension, f"mapping {index} names rejected source {source_id}")
        if citation_number in citation_numbers:
            _jig_189_error(
                errors,
                workflow_id,
                dimension,
                f"citation number {citation_number} is reused in one workflow",
            )
        citation_numbers.add(citation_number)
        if require_required_flag and entry.get("required") is not True:
            _jig_189_error(errors, workflow_id, dimension, f"mapping {index} must set required=true")
        pairs.append((source_id, citation_number))
    return pairs


def evaluate_jig_189_fixture(fixture: dict[str, object]) -> dict[str, object]:
    """Validate and score structured local workflow observations, never answer prose."""
    errors: list[str] = []
    if fixture.get("schema") != "jig-189-producer-workflows":
        errors.append("fixture: schema failed: unexpected schema name")
    if fixture.get("version") != 1:
        errors.append("fixture: schema failed: unsupported version")
    if fixture.get("default_mode") != "local_fixture":
        errors.append("fixture: execution failed: default mode must be local_fixture")
    rubric_dimensions = fixture.get("rubric_dimensions")
    if not isinstance(rubric_dimensions, list) or tuple(rubric_dimensions) != JIG_189_RUBRIC_DIMENSIONS:
        errors.append("fixture: schema failed: rubric dimensions are incomplete or reordered")

    categories = fixture.get("categories")
    if not isinstance(categories, list) or any(not isinstance(category, str) for category in categories):
        errors.append("fixture: category_coverage failed: categories must be a string list")
    else:
        if len(categories) != len(set(categories)):
            errors.append("fixture: category_coverage failed: category list contains duplicates")
        if set(categories) != JIG_189_REQUIRED_CATEGORIES:
            errors.append("fixture: category_coverage failed: required category set does not match")

    source_by_id: dict[str, dict[str, object]] = {}
    sources = fixture.get("sources")
    if not isinstance(sources, list):
        errors.append("fixture: evidence failed: sources must be a list")
    else:
        for index, source in enumerate(sources):
            if not isinstance(source, dict):
                errors.append(f"fixture: evidence failed: source {index} is not an object")
                continue
            source_id = source.get("id")
            if not isinstance(source_id, str) or not source_id:
                errors.append(f"fixture: evidence failed: source {index} has no id")
                continue
            if source_id in source_by_id:
                errors.append(f"fixture: evidence failed: duplicate source id {source_id}")
                continue
            source_by_id[source_id] = source
            if not isinstance(source.get("quality"), str) or source.get("quality") not in JIG_189_SOURCE_QUALITIES:
                errors.append(f"fixture: evidence failed: source {source_id} has invalid quality")
            if not isinstance(source.get("evidence_status"), str) or source.get("evidence_status") not in {
                "accepted",
                "rejected",
            }:
                errors.append(f"fixture: evidence failed: source {source_id} has invalid evidence status")
            publication_at = source.get("publication_at")
            retrieved_at = source.get("retrieved_at")
            if publication_at is not None and not isinstance(publication_at, str):
                errors.append(f"fixture: evidence failed: source {source_id} has invalid publication_at")
            if not isinstance(retrieved_at, str) or not retrieved_at:
                errors.append(f"fixture: evidence failed: source {source_id} has no retrieval timestamp")
            if publication_at is not None and publication_at == retrieved_at:
                errors.append(
                    f"fixture: evidence failed: source {source_id} conflates publication and retrieval time"
                )
            if source.get("evidence_status") == "rejected" and not isinstance(
                source.get("rejection_reason"), str
            ):
                errors.append(f"fixture: evidence failed: rejected source {source_id} has no rejection reason")

    live_subset = fixture.get("live_subset")
    live_ids: list[str] = []
    if not isinstance(live_subset, dict):
        errors.append("fixture: live_subset failed: live subset must be an object")
    else:
        raw_live_ids = live_subset.get("workflow_ids")
        if not isinstance(raw_live_ids, list) or any(not isinstance(value, str) for value in raw_live_ids):
            errors.append("fixture: live_subset failed: workflow_ids must be a string list")
        else:
            live_ids = list(raw_live_ids)
            if len(live_ids) != len(set(live_ids)):
                errors.append("fixture: live_subset failed: workflow_ids contain duplicates")
            if len(live_ids) > 3:
                errors.append("fixture: live_subset failed: subset is larger than three workflows")
        if live_subset.get("enabled_by_default") is not False:
            errors.append("fixture: live_subset failed: live execution is enabled by default")
        if live_subset.get("requires_explicit_opt_in") is not True:
            errors.append("fixture: live_subset failed: explicit opt-in is missing")
        if live_subset.get("execution_status") != "not_run":
            errors.append("fixture: live_subset failed: live subset must remain unrun")
        if not isinstance(live_subset.get("provider_calls"), int) or isinstance(
            live_subset.get("provider_calls"), bool
        ) or live_subset.get("provider_calls") != 0:
            errors.append("fixture: live_subset failed: provider calls must remain zero")

    workflows = fixture.get("workflows")
    workflow_scores: list[dict[str, object]] = []
    workflow_ids: list[str] = []
    workflow_by_id: dict[str, dict[str, object]] = {}
    if not isinstance(workflows, list):
        errors.append("fixture: count failed: workflows must be a list")
        workflows = []
    elif len(workflows) != 25:
        errors.append(f"fixture: count failed: expected 25 workflows, found {len(workflows)}")

    for index, workflow in enumerate(workflows):
        if not isinstance(workflow, dict):
            errors.append(f"fixture: schema failed: workflow {index} is not an object")
            continue
        workflow_id = workflow.get("id")
        if not isinstance(workflow_id, str) or not workflow_id:
            errors.append(f"fixture: schema failed: workflow {index} has no id")
            continue
        workflow_ids.append(workflow_id)
        if workflow_id in workflow_by_id:
            _jig_189_error(errors, workflow_id, "schema", "workflow id is not unique")
        workflow_by_id[workflow_id] = workflow
        for forbidden_field in JIG_189_FORBIDDEN_PROSE_FIELDS:
            if forbidden_field in workflow:
                _jig_189_error(errors, workflow_id, "schema", f"exact prose field {forbidden_field} is forbidden")
        if not isinstance(workflow.get("request"), str) or not workflow.get("request"):
            _jig_189_error(errors, workflow_id, "schema", "request must be a non-empty string")

        category = workflow.get("category")
        if not isinstance(category, str) or category not in JIG_189_REQUIRED_CATEGORIES:
            _jig_189_error(errors, workflow_id, "category_coverage", "unknown workflow category")
        turns = workflow.get("turns")
        workstreams = workflow.get("workstreams")
        if not isinstance(turns, list) or not turns or any(not isinstance(value, str) for value in turns):
            _jig_189_error(errors, workflow_id, "schema", "turns must be a non-empty string list")
            turn_count = 0
        else:
            turn_count = len(turns)
        if not isinstance(workstreams, list) or not workstreams or any(
            not isinstance(value, str) for value in workstreams
        ):
            _jig_189_error(errors, workflow_id, "schema", "workstreams must be a non-empty string list")
            workstream_count = 0
        else:
            workstream_count = len(workstreams)
        if workflow.get("multi_turn") is not (turn_count > 1):
            _jig_189_error(errors, workflow_id, "multi_turn", "flag does not match the turn list")
        if workflow.get("simultaneous") is not (workstream_count > 1):
            _jig_189_error(errors, workflow_id, "simultaneous", "flag does not match the workstream list")

        execution = workflow.get("execution")
        if not isinstance(execution, dict):
            _jig_189_error(errors, workflow_id, "execution", "execution metadata is missing")
            execution = {}
        if execution.get("default") != "local_fixture":
            _jig_189_error(errors, workflow_id, "execution", "default execution must use local_fixture")
        if not isinstance(execution.get("live_opt_in"), bool):
            _jig_189_error(errors, workflow_id, "execution", "live_opt_in must be boolean")

        expected_evidence = _jig_189_pairs(
            workflow.get("expected_evidence"),
            workflow_id=workflow_id,
            dimension="citation_support",
            errors=errors,
            source_by_id=source_by_id,
            require_required_flag=True,
        )
        allowed_pairs = _jig_189_pairs(
            workflow.get("allowed_citation_source_pairs"),
            workflow_id=workflow_id,
            dimension="citation_support",
            errors=errors,
            source_by_id=source_by_id,
        )
        observed = workflow.get("observed")
        observed_pairs: list[tuple[str, int]] = []
        if isinstance(observed, dict):
            observed_pairs = _jig_189_pairs(
                observed.get("citation_source_pairs"),
                workflow_id=workflow_id,
                dimension="citation_support",
                errors=errors,
                source_by_id=source_by_id,
            )
        else:
            _jig_189_error(errors, workflow_id, "schema", "observed structured result is missing")

        expected_failure_reasons = workflow.get("expected_failure_reasons")
        if not isinstance(expected_failure_reasons, list) or any(
            not isinstance(value, str) for value in expected_failure_reasons
        ):
            _jig_189_error(errors, workflow_id, "task_completion", "expected_failure_reasons must be a string list")
            expected_failure_reasons = []
        obstacles = workflow.get("retrieval_obstacles", [])
        if not isinstance(obstacles, list):
            _jig_189_error(errors, workflow_id, "evidence", "retrieval_obstacles must be a list")
            obstacles = []
        for obstacle in obstacles:
            if not isinstance(obstacle, dict):
                _jig_189_error(errors, workflow_id, "evidence", "retrieval obstacle is not an object")
                continue
            obstacle_source_id = obstacle.get("source_id")
            obstacle_reason = obstacle.get("reason")
            obstacle_source = (
                source_by_id.get(obstacle_source_id)
                if isinstance(obstacle_source_id, str)
                else None
            )
            if obstacle_source is None or obstacle_source.get("evidence_status") != "rejected":
                _jig_189_error(errors, workflow_id, "evidence", "obstacle must name a rejected source")
            elif obstacle_reason != obstacle_source.get("rejection_reason"):
                _jig_189_error(errors, workflow_id, "evidence", "obstacle reason does not match source rejection")

        expected = workflow.get("expected")
        if not isinstance(expected, dict):
            _jig_189_error(errors, workflow_id, "schema", "expected rubric result is missing")
            continue
        if not isinstance(observed, dict):
            continue

        required_format_traits = workflow.get("required_format_traits")
        observed_format_traits = observed.get("format_traits")
        if not isinstance(required_format_traits, list) or any(
            not isinstance(value, str) for value in required_format_traits
        ):
            _jig_189_error(errors, workflow_id, "format", "required format traits must be a string list")
            required_format_traits = []
        if not isinstance(observed_format_traits, list) or any(
            not isinstance(value, str) for value in observed_format_traits
        ):
            _jig_189_error(errors, workflow_id, "format", "observed format traits must be a string list")
            observed_format_traits = []
        for field in ("outcome", "currentness", "source_quality"):
            if field not in expected or field not in observed:
                _jig_189_error(errors, workflow_id, field, f"{field} is missing")
        if not isinstance(expected.get("outcome"), str) or not isinstance(
            observed.get("outcome"), str
        ) or expected.get("outcome") not in JIG_189_OUTCOMES or observed.get(
            "outcome"
        ) not in JIG_189_OUTCOMES:
            _jig_189_error(errors, workflow_id, "task_completion", "outcome is invalid")
        if not isinstance(expected.get("currentness"), str) or not isinstance(
            observed.get("currentness"), str
        ) or expected.get("currentness") not in JIG_189_CURRENTNESS_STATES or observed.get(
            "currentness"
        ) not in JIG_189_CURRENTNESS_STATES:
            _jig_189_error(errors, workflow_id, "currentness", "currentness state is invalid")
        if not isinstance(expected.get("source_quality"), str) or not isinstance(
            observed.get("source_quality"), str
        ) or expected.get("source_quality") not in JIG_189_SOURCE_QUALITIES or observed.get(
            "source_quality"
        ) not in JIG_189_SOURCE_QUALITIES:
            _jig_189_error(errors, workflow_id, "source_quality", "source quality is invalid")
        if not isinstance(expected.get("task_completed"), bool) or not isinstance(
            observed.get("task_completed"), bool
        ):
            _jig_189_error(errors, workflow_id, "task_completion", "task_completed must be boolean")
        if not isinstance(expected.get("caveats_required"), bool) or not isinstance(
            observed.get("caveats_present"), bool
        ):
            _jig_189_error(errors, workflow_id, "caveats", "caveat flags must be boolean")
        if not isinstance(expected.get("newsroom_usefulness"), bool) or not isinstance(
            observed.get("newsroom_usefulness"), bool
        ):
            _jig_189_error(errors, workflow_id, "newsroom_usefulness", "newsroom usefulness must be boolean")
        observed_failure_reasons = observed.get("failure_reasons")
        if not isinstance(observed_failure_reasons, list) or any(
            not isinstance(value, str) for value in observed_failure_reasons
        ):
            _jig_189_error(errors, workflow_id, "task_completion", "observed failure reasons must be a string list")
            observed_failure_reasons = []
        if expected.get("outcome") == "expected_failure" and not expected_failure_reasons:
            _jig_189_error(errors, workflow_id, "task_completion", "expected failures need a failure reason")
        if expected.get("outcome") == "success" and expected_failure_reasons:
            _jig_189_error(errors, workflow_id, "task_completion", "successful workflows cannot expect failure reasons")

        expected_pairs_set = set(expected_evidence)
        allowed_pairs_set = set(allowed_pairs)
        observed_pairs_set = set(observed_pairs)
        citation_pass = expected_pairs_set <= observed_pairs_set and observed_pairs_set <= allowed_pairs_set
        citation_detail = (
            f"required={sorted(expected_pairs_set)}, observed={sorted(observed_pairs_set)}, "
            f"allowed={sorted(allowed_pairs_set)}"
        )
        task_pass = (
            observed.get("outcome") == expected.get("outcome")
            and observed.get("task_completed") == expected.get("task_completed")
            and observed_failure_reasons == expected_failure_reasons
        )
        task_detail = (
            f"expected outcome={expected.get('outcome')!r}, observed outcome={observed.get('outcome')!r}; "
            f"expected failure reasons={expected_failure_reasons!r}, observed={observed_failure_reasons!r}"
        )
        dimension_checks = {
            "task_completion": (task_pass, task_detail),
            "currentness": (
                observed.get("currentness") == expected.get("currentness"),
                f"expected {expected.get('currentness')!r}, observed {observed.get('currentness')!r}",
            ),
            "source_quality": (
                observed.get("source_quality") == expected.get("source_quality"),
                f"expected {expected.get('source_quality')!r}, observed {observed.get('source_quality')!r}",
            ),
            "citation_support": (citation_pass, citation_detail),
            "caveats": (
                observed.get("caveats_present") == expected.get("caveats_required"),
                f"expected required={expected.get('caveats_required')!r}, observed present={observed.get('caveats_present')!r}",
            ),
            "format": (
                set(required_format_traits).issubset(set(observed_format_traits)),
                f"required={required_format_traits!r}, observed={observed_format_traits!r}",
            ),
            "newsroom_usefulness": (
                observed.get("newsroom_usefulness") == expected.get("newsroom_usefulness"),
                f"expected {expected.get('newsroom_usefulness')!r}, observed {observed.get('newsroom_usefulness')!r}",
            ),
        }
        dimension_results: dict[str, dict[str, object]] = {}
        workflow_passed = 0
        for dimension in JIG_189_RUBRIC_DIMENSIONS:
            passed, detail = dimension_checks[dimension]
            if passed:
                workflow_passed += 1
            else:
                _jig_189_error(errors, workflow_id, dimension, detail)
            dimension_results[dimension] = {
                "passed": int(passed),
                "total": 1,
                "ratio": float(int(passed)),
            }
        workflow_scores.append(
            {
                "workflow_id": workflow_id,
                "passed": workflow_passed,
                "total": len(JIG_189_RUBRIC_DIMENSIONS),
                "ratio": workflow_passed / len(JIG_189_RUBRIC_DIMENSIONS),
                "dimensions": dimension_results,
            }
        )

    if len(workflow_ids) != len(set(workflow_ids)):
        errors.append("fixture: count failed: workflow ids contain duplicates")
    actual_categories = {
        workflow.get("category")
        for workflow in workflows
        if isinstance(workflow, dict) and isinstance(workflow.get("category"), str)
    }
    missing_categories = JIG_189_REQUIRED_CATEGORIES - actual_categories
    if missing_categories:
        errors.append(
            f"fixture: category_coverage failed: missing {sorted(missing_categories)}"
        )
    for live_id in live_ids:
        workflow = workflow_by_id.get(live_id)
        if workflow is None:
            errors.append(f"fixture: live_subset failed: unknown workflow {live_id}")
        elif not isinstance(workflow.get("execution"), dict) or not workflow["execution"].get("live_opt_in"):
            errors.append(f"{live_id}: live_subset failed: workflow is not live_opt_in")
    for workflow_id, workflow in workflow_by_id.items():
        execution = workflow.get("execution")
        live_opt_in = execution.get("live_opt_in") if isinstance(execution, dict) else None
        if live_opt_in is True and workflow_id not in live_ids:
            errors.append(f"{workflow_id}: live_subset failed: live_opt_in workflow is not listed")

    passed = sum(int(result["passed"]) for result in workflow_scores)
    total = sum(int(result["total"]) for result in workflow_scores)
    if not 0 <= passed <= total:
        errors.append("fixture: score failed: aggregate score is outside its bounds")
    return {
        "passed": passed,
        "total": total,
        "ratio": passed / total if total else 0.0,
        "workflows": workflow_scores,
        "workflow_ids": workflow_ids,
        "default_workflow_ids": [
            workflow_id
            for workflow_id, workflow in workflow_by_id.items()
            if isinstance(workflow.get("execution"), dict)
            and workflow["execution"].get("default") == "local_fixture"
        ],
        "live_workflow_ids": live_ids,
        "errors": errors,
    }


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
            agent = SimpleNamespace(
                ephemeral_system_prompt="Thread override remains available.",
                session_id="hermes-generated-session",
            )
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
        self.assertEqual(agent.session_id, "thread")
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

    def test_jig_190_scores_material_claim_support_at_paragraph_level(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "jig_190_citation_support.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

        score = citation_support_score(fixture)
        self.assertEqual(score["passed"], 4)
        self.assertEqual(score["total"], 5)
        self.assertEqual(score["ratio"], 0.8)

        claim_results = {claim["id"]: claim["supported"] for claim in score["claims"]}
        expected_results = {
            claim["id"]: claim["expected_supported"]
            for claim in fixture["expected_material_claims"]
        }
        self.assertEqual(claim_results, expected_results)
        self.assertFalse(claim_results["unsupported-fare-cut"])

        paragraphs = {paragraph["id"]: paragraph["text"] for paragraph in fixture["paragraphs"]}
        self.assertEqual(citation_numbers(paragraphs["transit"]), {1})
        self.assertEqual(paragraphs["transit"].count("[1]"), 1)
        self.assertGreaterEqual(paragraphs["transit"].count("."), 2)

        source_change = fixture["source_change"]
        changed_citations = [
            citation_numbers(paragraphs[paragraph_id])
            for paragraph_id in source_change["paragraph_ids"]
        ]
        self.assertEqual(changed_citations, [{1}, {2}])
        self.assertEqual(source_change["expected_citation_numbers"], [1, 2])
        self.assertNotEqual(*changed_citations)

    def test_jig_189_has_25_local_workflows_and_scores_all_rubric_dimensions(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "jig_189_producer_workflows.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

        score = evaluate_jig_189_fixture(fixture)

        self.assertEqual(score["errors"], [])
        self.assertEqual(len(score["workflow_ids"]), 25)
        self.assertEqual(score["passed"], 25 * len(JIG_189_RUBRIC_DIMENSIONS))
        self.assertEqual(score["total"], 25 * len(JIG_189_RUBRIC_DIMENSIONS))
        self.assertEqual(score["ratio"], 1.0)
        self.assertEqual(set(score["default_workflow_ids"]), set(score["workflow_ids"]))
        self.assertEqual(
            set(score["live_workflow_ids"]),
            {"desk-update-simultaneous", "freshness-recheck-multi-turn"},
        )
        self.assertEqual(sum(workflow["multi_turn"] for workflow in fixture["workflows"]), 6)
        self.assertEqual(sum(workflow["simultaneous"] for workflow in fixture["workflows"]), 3)
        self.assertEqual(evaluate_jig_189_fixture(fixture), score)

        live_subset = fixture["live_subset"]
        self.assertFalse(live_subset["enabled_by_default"])
        self.assertTrue(live_subset["requires_explicit_opt_in"])
        self.assertEqual(live_subset["execution_status"], "not_run")
        self.assertEqual(live_subset["provider_calls"], 0)
        for workflow in score["workflows"]:
            self.assertEqual(workflow["total"], len(JIG_189_RUBRIC_DIMENSIONS))
            self.assertGreaterEqual(workflow["passed"], 0)
            self.assertLessEqual(workflow["passed"], workflow["total"])
            self.assertEqual(
                set(workflow["dimensions"]),
                set(JIG_189_RUBRIC_DIMENSIONS),
            )

    def test_jig_189_reports_workflow_and_rubric_dimension_for_invalid_fixture(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "jig_189_producer_workflows.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

        format_fixture = deepcopy(fixture)
        format_fixture["workflows"][0]["observed"]["format_traits"].remove("lead_first")
        format_score = evaluate_jig_189_fixture(format_fixture)
        self.assertTrue(
            any(
                error.startswith("breaking-update-local: format failed:")
                for error in format_score["errors"]
            )
        )

        duplicate_fixture = deepcopy(fixture)
        duplicate_fixture["workflows"][1]["id"] = duplicate_fixture["workflows"][0]["id"]
        duplicate_score = evaluate_jig_189_fixture(duplicate_fixture)
        self.assertTrue(
            any(
                error == "breaking-update-local: schema failed: workflow id is not unique"
                for error in duplicate_score["errors"]
            )
        )


if __name__ == "__main__":
    unittest.main()
