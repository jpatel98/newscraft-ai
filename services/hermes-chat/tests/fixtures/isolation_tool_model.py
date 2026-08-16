"""Deterministic OpenAI-compatible model for the Docker isolation smoke test.

The model accepts a user message in this form::

    STAGING_TOOL <tool-name> <json-arguments>

It emits exactly one tool call. On the next model request, it returns the
tool result as text. It is intentionally local and contains no provider key.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


HOST = "127.0.0.1"
PORT = int(os.environ.get("NEWSCRAFT_ISOLATION_MODEL_PORT", "18767"))
MODEL = "newscraft-hermes-isolation-test"
_DIRECTIVE = re.compile(r"STAGING_TOOL\s+([A-Za-z0-9_]+)\s+(\{.*\})", re.DOTALL)


def _message_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    return "\n".join(
        str(part.get("text") or "")
        for part in value
        if isinstance(part, dict) and part.get("type") == "text"
    )


def _latest_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return _message_text(message.get("content"))
    return ""


def _latest_tool_result(messages: list[dict[str, Any]]) -> str | None:
    for message in reversed(messages):
        if message.get("role") == "tool":
            value = message.get("content")
            return value if isinstance(value, str) else json.dumps(value)
    return None


def _tool_call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"call_{uuid.uuid4().hex[:12]}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, ensure_ascii=False, separators=(",", ":")),
        },
    }


def _response(messages: list[dict[str, Any]]) -> tuple[str, object]:
    result = _latest_tool_result(messages)
    if result is not None:
        return "text", f"STAGING_TOOL_RESULT {result}"

    user_text = _latest_user_text(messages)
    match = _DIRECTIVE.search(user_text)
    if not match:
        if "STAGING_MEMORY_PROBE" in user_text:
            rendered = json.dumps(messages, ensure_ascii=False)
            markers = sorted(
                set(
                    re.findall(
                        r"(?:ACCOUNT|MEMORY|NAME)_[A-Za-z0-9_-]+",
                        rendered,
                    )
                )
            )
            return "text", f"STAGING_MEMORY_VISIBLE {','.join(markers)}"
        return "text", "STAGING_MODEL_OK"
    try:
        arguments = json.loads(match.group(2))
    except json.JSONDecodeError as exc:
        return "text", f"STAGING_TOOL_ARGUMENT_ERROR {exc}"
    if not isinstance(arguments, dict):
        return "text", "STAGING_TOOL_ARGUMENT_ERROR object required"
    return "tool", _tool_call(match.group(1), arguments)


class _Handler(BaseHTTPRequestHandler):
    server_version = "NewsCraftHermesIsolationModel/1.0"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _json(self, status: int, value: object) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/v1/models":
            self._json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
            return
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._json(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": {"message": "invalid json"}})
            return

        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        kind, value = _response(messages)
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        if kind == "tool":
            delta = {"role": "assistant", "tool_calls": [{"index": 0, **value}]}
            finish_reason = "tool_calls"
        else:
            delta = {"role": "assistant", "content": str(value)}
            finish_reason = "stop"
        chunks = [
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "model": MODEL,
                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
            },
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "model": MODEL,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
            },
        ]
        payload = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
        encoded = (payload + "data: [DONE]\n\n").encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)
        self.wfile.flush()


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), _Handler).serve_forever()
