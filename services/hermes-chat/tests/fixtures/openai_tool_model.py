from __future__ import annotations

import json
import os
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


HOST = "127.0.0.1"
PORT = int(os.environ.get("NEWSCRAFT_FAKE_MODEL_PORT", "8769"))
MODEL = "newscraft-hermes-tool-verification"
ERROR_STATUS = int(os.environ.get("NEWSCRAFT_FAKE_MODEL_ERROR_STATUS", "0"))
EXPECTED_TOOLS = {
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


def json_object(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except ValueError:
        parsed = None
        decoder = json.JSONDecoder()
        for index, character in enumerate(value):
            if character != "{":
                continue
            try:
                candidate, _ = decoder.raw_decode(value[index:])
            except ValueError:
                continue
            if isinstance(candidate, dict):
                parsed = candidate
                break
    return parsed if isinstance(parsed, dict) else {}


def message_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    return "\n".join(
        str(part.get("text") or "")
        for part in value
        if isinstance(part, dict) and part.get("type") == "text"
    )


def latest_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return message_text(message.get("content"))
    return ""


def latest_tool_result(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for message in reversed(messages):
        if message.get("role") == "tool":
            return json_object(message.get("content"))
    return {}


def latest_tool_name(messages: list[dict[str, Any]]) -> str:
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


def tool_call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"call_{uuid.uuid4().hex[:12]}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, ensure_ascii=False, separators=(",", ":")),
        },
    }


def next_response(messages: list[dict[str, Any]]) -> tuple[str, object]:
    tool_result = latest_tool_result(messages)
    tool_name = latest_tool_name(messages)
    if tool_result and tool_name == "browser_navigate":
        return "tool", tool_call("browser_snapshot", {"full": True})
    if tool_result and tool_name == "browser_snapshot":
        snapshot = str(tool_result.get("snapshot") or "").strip()
        if tool_result.get("success") is False or not snapshot:
            return "text", "Hermes could not read the page with its standard browser."
        return "text", "Hermes used its standard browser to open and read the article [1]."

    match = re.search(r"https?://[^\s<>\]\[()]+", latest_user_text(messages))
    if match:
        return "tool", tool_call("browser_navigate", {"url": match.group(0).rstrip(".,;:")})
    return "text", "Hermes local standard-tool path passed."


class Handler(BaseHTTPRequestHandler):
    server_version = "NewsCraftHermesToolModel/1.0"

    def log_message(self, format: str, *args: object) -> None:
        return

    def send_json(self, status: int, value: object) -> None:
        data = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/v1/models":
            self.send_json(
                200,
                {
                    "object": "list",
                    "data": [{"id": MODEL, "object": "model", "owned_by": "newscraft-local"}],
                },
            )
            return
        self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_json(404, {"error": {"message": "not found"}})
            return
        if ERROR_STATUS:
            self.send_json(ERROR_STATUS, {"error": {"message": "deterministic model failure"}})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": {"message": "invalid json"}})
            return

        tools = body.get("tools") if isinstance(body.get("tools"), list) else []
        names = {
            str(tool.get("function", {}).get("name") or "")
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
        }
        missing = sorted(EXPECTED_TOOLS - names)
        if missing:
            self.send_json(400, {"error": {"message": f"missing standard Hermes tools: {missing}"}})
            return

        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        kind, value = next_response(messages)
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
            payload = json.dumps(chunk, separators=(",", ":"))
            self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
