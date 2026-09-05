"""Deterministic OpenAI-compatible model for the real artifact tool path.

The first model turn emits the registered ``publish_artifact`` server-tool
call.  After Hermes returns that tool result, the second turn emits a short
assistant answer.  The fixture reads only bounded, explicit file metadata from
the environment; it never receives a host path from the application.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


HOST = "127.0.0.1"
PORT = int(os.environ.get("NEWSCRAFT_FAKE_MODEL_PORT", "8769"))
MODEL = "newscraft-hermes-artifact-fixture"
ERROR_STATUS = int(os.environ.get("NEWSCRAFT_FAKE_MODEL_ERROR_STATUS", "0"))
EXPECTED_STANDARD_TOOLS = {
    "browser_navigate",
    "browser_snapshot",
    "delegate_task",
    "execute_code",
    "patch",
    "process",
    "read_file",
    "search_files",
    "terminal",
    "web_extract",
    "web_search",
    "write_file",
}


def _json_object(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


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


def _latest_tool_result(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for message in reversed(messages):
        if message.get("role") == "tool":
            return _json_object(message.get("content"))
    return {}


def _latest_tool_name(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") != "assistant":
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in reversed(calls):
            function = call.get("function") if isinstance(call, dict) else None
            if isinstance(function, dict) and isinstance(function.get("name"), str):
                return function["name"]
    return ""


def _tool_call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"call_{uuid.uuid4().hex[:12]}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, ensure_ascii=False, separators=(",", ":")),
        },
    }


def _fixture_args() -> dict[str, Any]:
    path = os.environ.get("NEWSCRAFT_ARTIFACT_FIXTURE_PATH", "/workspace/fixture.png").strip()
    size = int(os.environ.get("NEWSCRAFT_ARTIFACT_FIXTURE_SIZE", "68"))
    checksum = os.environ.get(
        "NEWSCRAFT_ARTIFACT_FIXTURE_SHA256",
        "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
    ).strip()
    return {
        "spec": {
            "kind": "image",
            "title": "Deterministic artifact fixture",
            "alt": "A one-pixel deterministic fixture image",
            "caption": "Published through the registered Hermes artifact tool.",
        },
        "title": "Deterministic artifact fixture",
        "path": path,
        "mime_type": "image/png",
        "size": size,
        "checksum_sha256": checksum,
    }


def _next_response(messages: list[dict[str, Any]]) -> tuple[str, object]:
    tool_result = _latest_tool_result(messages)
    tool_name = _latest_tool_name(messages)
    if tool_name == "publish_artifact" and tool_result:
        if tool_result.get("artifact") or tool_result.get("revision_id"):
            return "text", "The deterministic image artifact was published and is ready."
        return "text", "The artifact publication fixture returned an unexpected result."

    # This ordinary-chat fixture only invokes the artifact capability when the
    # user asks for the explicit fixture phrase; otherwise it remains a normal
    # text response so it is safe to probe with a basic chat request.
    user_text = ""
    for message in reversed(messages):
        if message.get("role") == "user":
            user_text = _message_text(message.get("content"))
            break
    if re.search(r"artifact|canvas|fixture", user_text, re.IGNORECASE):
        return "tool", _tool_call("publish_artifact", _fixture_args())
    return "text", "Hermes deterministic ordinary chat passed."


class Handler(BaseHTTPRequestHandler):
    server_version = "NewsCraftHermesArtifactModel/1.0"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_json(self, status: int, value: object) -> None:
        data = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/v1/models":
            self._send_json(
                200,
                {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "newscraft-local"}]},
            )
            return
        self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send_json(404, {"error": {"message": "not found"}})
            return
        if ERROR_STATUS:
            self._send_json(ERROR_STATUS, {"error": {"message": "deterministic model failure"}})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": {"message": "invalid json"}})
            return

        tools = body.get("tools") if isinstance(body.get("tools"), list) else []
        names = {
            str(tool.get("function", {}).get("name") or "")
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
        }
        missing = sorted(EXPECTED_STANDARD_TOOLS - names)
        if missing or "publish_artifact" not in names:
            self._send_json(400, {"error": {"message": f"missing registered tools: {missing or ['publish_artifact']}"}})
            return

        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        kind, value = _next_response(messages)
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
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
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
