#!/usr/bin/env python3
"""JSON-only bridge from the web UI to local Hermes skill metadata."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


SAFE_BUILTINS = {"/help", "/commands", "/status", "/profile"}
BLOCKED_REASON = "This command is not available from the web UI yet."
SUPPORTING_DIRS = ("references", "templates", "scripts", "assets")


def _agent_dir() -> Path:
    return Path(os.environ.get("HERMES_AGENT_DIR", "~/.hermes/hermes-agent")).expanduser()


AGENT_DIR = _agent_dir()
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def _fail(message: str, code: int = 1) -> None:
    _emit({"error": message})
    raise SystemExit(code)


def _display_path(path: str | Path) -> str:
    p = Path(path).expanduser()
    home = Path.home()
    try:
        return "~/" + str(p.resolve().relative_to(home))
    except Exception:
        return p.name


def _skill_category(path: str | Path) -> str | None:
    p = Path(path)
    parent = p.parent.name
    if parent and parent != "skills":
        return parent
    return None


def _skill_command_rows() -> list[dict[str, Any]]:
    from agent.skill_commands import get_skill_commands

    rows: list[dict[str, Any]] = []
    for slash, info in sorted(get_skill_commands().items(), key=lambda item: item[0]):
        skill_dir = info.get("skill_dir") or str(Path(info.get("skill_md_path", "")).parent)
        rows.append(
            {
                "name": str(info.get("name") or slash.lstrip("/")),
                "slash": slash,
                "description": str(info.get("description") or f"Invoke {slash}"),
                "category": _skill_category(skill_dir),
                "path": _display_path(skill_dir),
                "enabled": True,
            }
        )
    return rows


def _builtin_command_rows() -> list[dict[str, Any]]:
    from hermes_cli.commands import COMMAND_REGISTRY

    rows: list[dict[str, Any]] = []
    for cmd in COMMAND_REGISTRY:
        slash = f"/{cmd.name}"
        enabled = slash in SAFE_BUILTINS
        rows.append(
            {
                "name": cmd.name,
                "slash": slash,
                "description": cmd.description,
                "category": cmd.category,
                "argsHint": cmd.args_hint or None,
                "kind": "builtin",
                "enabled": enabled,
                "blockedReason": None if enabled else BLOCKED_REASON,
            }
        )
    return rows


def commands() -> None:
    builtins = _builtin_command_rows()
    skills = [
        {
            "name": s["name"],
            "slash": s["slash"],
            "description": s["description"],
            "category": s.get("category") or "Skills",
            "argsHint": "[instruction]",
            "kind": "skill",
            "enabled": s["enabled"],
            "blockedReason": None,
        }
        for s in _skill_command_rows()
    ]
    _emit({"commands": builtins + skills})


def skills() -> None:
    _emit({"skills": _skill_command_rows()})


def _skill_info(slug: str) -> tuple[str, dict[str, Any]] | None:
    from agent.skill_commands import get_skill_commands, resolve_skill_command_key

    key = resolve_skill_command_key(slug.lstrip("/")) or f"/{slug.lstrip('/')}"
    info = get_skill_commands().get(key)
    if not info:
        return None
    return key, info


def skill_detail(slug: str) -> None:
    from agent.skill_utils import parse_frontmatter

    found = _skill_info(slug)
    if not found:
        _fail("skill not found", 2)
    slash, info = found
    skill_md = Path(info["skill_md_path"]).expanduser()
    skill_dir = Path(info["skill_dir"]).expanduser()
    raw = skill_md.read_text(encoding="utf-8")
    frontmatter, body = parse_frontmatter(raw)
    supporting: list[str] = []
    for dirname in SUPPORTING_DIRS:
        root = skill_dir / dirname
        if not root.exists():
            continue
        for f in sorted(root.rglob("*")):
            if f.is_file() and not f.is_symlink():
                try:
                    supporting.append(str(f.relative_to(skill_dir)))
                except Exception:
                    continue
            if len(supporting) >= 200:
                break
    _emit(
        {
            "skill": {
                "name": str(info.get("name") or frontmatter.get("name") or slash.lstrip("/")),
                "slash": slash,
                "description": str(
                    info.get("description")
                    or frontmatter.get("description")
                    or f"Invoke the {slash} skill"
                ),
                "category": _skill_category(skill_dir),
                "path": _display_path(skill_dir),
                "enabled": True,
                "frontmatter": frontmatter,
                "content": body.strip(),
                "supportingFiles": supporting,
            }
        }
    )


def expand_skill(slash: str, instruction: str, task_id: str | None = None) -> None:
    import agent.skill_commands as skill_commands

    # The web bridge expands skill prompts only; it must not execute inline
    # shell snippets from SKILL.md during expansion.
    skill_commands._load_skills_config = lambda: {"template_vars": True, "inline_shell": False}  # type: ignore[attr-defined]
    key = skill_commands.resolve_skill_command_key(slash.lstrip("/"))
    if not key:
        _fail("skill command not found", 2)
    content = skill_commands.build_skill_invocation_message(key, instruction, task_id=task_id)
    if not content:
        _fail("skill command did not expand", 3)
    _emit({"content": content})


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        _fail("usage: hermes-bridge.py <commands|skills|skill-detail|expand-skill> ...")
    action = argv[1]
    if action == "commands":
        commands()
    elif action == "skills":
        skills()
    elif action == "skill-detail" and len(argv) >= 3:
        skill_detail(argv[2])
    elif action == "expand-skill" and len(argv) >= 3:
        expand_skill(argv[2], argv[3] if len(argv) >= 4 else "", argv[4] if len(argv) >= 5 else None)
    else:
        _fail("invalid action")


if __name__ == "__main__":
    main(sys.argv)
