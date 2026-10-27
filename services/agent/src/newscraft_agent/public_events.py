"""The public run-event contract: the only event types stored for the browser.

Mirrors packages/shared/src/agent-contract.ts; test_public_events.py fails if the
two drift. The browser labels activity by tool *kind*, never by internal tool
name, so a renamed or new tool only needs an entry in TOOL_KINDS.
"""
from __future__ import annotations

from typing import Final

AGENT_CONTRACT_VERSION: Final = 2

RUN_STARTED: Final = "run.started"
RUN_FAILED: Final = "run.failed"
RUN_CANCELLED: Final = "run.cancelled"
PLAN: Final = "agent.plan"
DECISION: Final = "agent.decision"
TOOL_PROGRESS: Final = "agent.tool.progress"
SOURCE_FOUND: Final = "agent.source.found"
SOURCE_READ: Final = "agent.source.read"
CITATIONS: Final = "agent.citations"
ANSWER_DELTA: Final = "response.output_text.delta"
ANSWER_REPLACE: Final = "agent.answer.replace"
ARTIFACT_READY: Final = "artifact.ready"
COMPLETED: Final = "response.completed"
FAILED: Final = "response.failed"

PUBLIC_EVENTS: Final = (RUN_STARTED, RUN_FAILED, RUN_CANCELLED, PLAN, DECISION, TOOL_PROGRESS, SOURCE_FOUND,
                        SOURCE_READ, CITATIONS, ANSWER_DELTA, ANSWER_REPLACE, ARTIFACT_READY, COMPLETED, FAILED)

TOOL_KIND_NAMES: Final = ("search", "read", "verify", "cite", "publish", "files", "compute", "browse", "plan",
                          "decision", "tool")

# Internal tool name -> public kind. Unknown tools are "tool".
TOOL_KINDS: Final = {
    "web_search": "search",
    "web_extract": "read",
    "verify_this_lead": "verify",
    "record_newscraft_source": "cite",
    "publish_markdown": "publish",
    "publish_csv": "publish",
    "read_file": "files",
    "write_file": "files",
    "list_files": "files",
    "terminal": "compute",
    "browser": "browse",
    "plan": "plan",
    "decision": "decision",
}


def tool_kind(name: str) -> str:
    if name in TOOL_KINDS:
        return TOOL_KINDS[name]
    if name.startswith("browser_"):
        return "browse"
    return "tool"
