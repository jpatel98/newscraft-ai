"""Stateless model transports. NewsCraft owns messages, tool dispatch and runs.

Provider-specific continuation is private and bound to one provider/model/run.
Canonical messages never require a provider response/session identifier.
"""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from .runtime import strict_schema
from .provider_policy import DEEPSEEK_MODELS

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class ModelError(RuntimeError):
    """Safe provider error; never includes a raw response or credentials."""


@dataclass
class ModelReply:
    message: dict[str, Any]
    private: dict[str, Any]
    usage: dict[str, int]


class ModelAdapter(Protocol):
    name: str
    def budget_input(self, *, messages, private, instructions, tools) -> dict[str, Any]: ...
    async def complete(self, *, model: str, instructions: str, messages: list[dict[str, Any]],
                       tools: list[dict[str, Any]], max_output: int, private: dict[str, Any]) -> ModelReply: ...


def usage(value: Any) -> dict[str, int]:
    return {key: item for key in ("input_tokens", "output_tokens")
            if isinstance(value, dict) and isinstance(item := value.get(key), int)
            and not isinstance(item, bool) and 0 <= item <= 10_000_000}


def call(block: dict[str, Any], *, identifier: str, arguments: Any) -> dict[str, Any]:
    name = block.get("name")
    if (not isinstance(identifier, str) or not identifier or len(identifier) > 160 or
            not isinstance(name, str) or not name or len(name) > 128 or not isinstance(arguments, dict)):
        raise ModelError("The model returned an invalid tool call.")
    if len(json.dumps(arguments).encode()) > 128_000:
        raise ModelError("The model tool arguments exceeded their size limit.")
    return {"type": "tool_call", "id": identifier, "name": name, "arguments": arguments}


class HTTPModel:
    def __init__(self, settings, *, client: httpx.AsyncClient | None = None):
        self.settings, self.client = settings, client

    async def post(self, path, headers, payload):
        client = self.client or httpx.AsyncClient(timeout=min(60, self.settings.max_seconds), trust_env=False, follow_redirects=False)
        try:
            # No automatic retries: a disconnected paid request is uncertain.
            async with client.stream("POST", self.settings.model_base_url.rstrip("/") + path,
                                     headers=headers, json=payload) as response:
                if response.status_code >= 400:
                    raise ModelError(f"The model request failed (HTTP {response.status_code}).")
                data = bytearray()
                async for part in response.aiter_bytes():
                    data.extend(part)
                    if len(data) > MAX_RESPONSE_BYTES:
                        raise ModelError("The model response exceeded its size limit.")
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise ValueError()
                return value
        except (httpx.HTTPError, ValueError):
            raise ModelError("The model request outcome is uncertain; it was not retried.") from None
        finally:
            if self.client is None:
                await client.aclose()


class OpenAIResponses(HTTPModel):
    name = "openai"

    def budget_input(self, *, messages, private, instructions, tools):
        return {"instructions": instructions, "input": self.encode(messages, private),
                "tools": [{"type": "function", "name": t["name"], "description": t["description"],
                           "parameters": strict_schema(t["parameters"]), "strict": True} for t in tools]}

    @staticmethod
    def encode(messages, private):
        result = []
        replay = private.get("replay", {})
        for index, message in enumerate(messages):
            if str(index) in replay:
                result.extend(copy.deepcopy(replay[str(index)]))
                continue
            content = []
            for block in message["content"]:
                kind = block["type"]
                if kind == "text":
                    content.append({"type": "output_text" if message["role"] == "assistant" else "input_text", "text": block["text"]})
                elif kind == "image":
                    content.append({"type": "input_image", "image_url": f"data:{block['media_type']};base64,{block['data']}"})
                else:
                    if content:
                        result.append({"role": message["role"], "content": content})
                        content = []
                    if kind == "tool_call":
                        result.append({"type": "function_call", "call_id": block["id"], "name": block["name"], "arguments": json.dumps(block["arguments"])})
                    elif kind == "tool_result":
                        result.append({"type": "function_call_output", "call_id": block["id"], "output": block["output"]})
            if content:
                result.append({"role": message["role"], "content": content})
        return result

    async def complete(self, *, model, instructions, messages, tools, max_output, private):
        payload = {"model": model, **self.budget_input(messages=messages, private=private, instructions=instructions, tools=tools),
                   "store": False, "service_tier": "default", "include": ["reasoning.encrypted_content"], "max_output_tokens": max_output}
        response = await self.post("/responses", {"authorization": f"Bearer {self.settings.model_api_key}"}, payload)
        if response.get("status") != "completed" or not isinstance(response.get("output"), list):
            raise ModelError("The model did not return a complete response.")
        blocks, replay = [], []
        for item in response["output"]:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind == "reasoning":
                encrypted = item.get("encrypted_content")
                if isinstance(encrypted, str) and isinstance(item.get("id"), str):
                    replay.append({"type": "reasoning", "id": item["id"], "summary": [], "encrypted_content": encrypted})
            elif kind == "function_call":
                try:
                    args = json.loads(item.get("arguments", ""))
                except (ValueError, TypeError):
                    raise ModelError("The model tool arguments were invalid.") from None
                value = call(item, identifier=item.get("call_id"), arguments=args)
                blocks.append(value)
                replay.append({"type": "function_call", "call_id": value["id"], "name": value["name"], "arguments": json.dumps(args)})
            elif kind == "message" and item.get("role") == "assistant":
                parts = [{"type": "output_text", "text": p["text"]} for p in item.get("content", [])
                         if isinstance(p, dict) and p.get("type") == "output_text" and isinstance(p.get("text"), str)]
                blocks.extend({"type": "text", "text": p["text"]} for p in parts)
                replay.append({"type": "message", "role": "assistant", "content": parts,
                               **({"phase": item["phase"]} if item.get("phase") in {"commentary", "final_answer"} else {})})
        continuation = copy.deepcopy(private)
        continuation.setdefault("replay", {})[str(len(messages))] = replay
        return ModelReply({"role": "assistant", "content": blocks}, continuation, usage(response.get("usage")))


class AnthropicMessages(HTTPModel):
    name = "anthropic"
    path = "/messages"

    def request_options(self, model):
        return {"service_tier": "standard_only"}

    def request_headers(self):
        return {"x-api-key": self.settings.model_api_key, "anthropic-version": "2023-06-01"}

    def budget_input(self, *, messages, private, instructions, tools):
        return {"system": instructions, "messages": self.encode(messages),
                "tools": [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools]}

    @staticmethod
    def encode(messages):
        result = []
        for message in messages:
            blocks = []
            for part in message["content"]:
                kind = part["type"]
                if kind == "text":
                    blocks.append({"type": "text", "text": part["text"]})
                elif kind == "image":
                    blocks.append({"type": "image", "source": {"type": "base64", "media_type": part["media_type"], "data": part["data"]}})
                elif kind == "tool_call":
                    blocks.append({"type": "tool_use", "id": part["id"], "name": part["name"], "input": part["arguments"]})
                elif kind == "tool_result":
                    blocks.append({"type": "tool_result", "tool_use_id": part["id"], "content": part["output"], "is_error": bool(part.get("failed"))})
            if not blocks:
                continue
            role = "assistant" if message["role"] == "assistant" else "user"
            if result and result[-1]["role"] == role:
                result[-1]["content"].extend(blocks)
            else:
                result.append({"role": role, "content": blocks})
        return result

    async def complete(self, *, model, instructions, messages, tools, max_output, private):
        response = await self.post(self.path, self.request_headers(),
            {"model": model, "max_tokens": max_output, **self.request_options(model),
             **self.budget_input(messages=messages, private=private, instructions=instructions, tools=tools)})
        if response.get("stop_reason") not in {"end_turn", "tool_use", "stop_sequence"} or not isinstance(response.get("content"), list):
            raise ModelError("The model did not return a complete response.")
        blocks = []
        for item in response["content"]:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                blocks.append({"type": "text", "text": item["text"]})
            elif item.get("type") == "tool_use":
                blocks.append(call(item, identifier=item.get("id"), arguments=item.get("input")))
            # Thinking, signatures, private/unknown blocks never enter the ledger.
        return ModelReply({"role": "assistant", "content": blocks}, {}, usage(response.get("usage")))


class DeepSeekMessages(AnthropicMessages):
    """DeepSeek's Messages dialect; no implicit model or reasoning-mode mapping.

    Non-thinking mode supports tools and avoids private thinking continuation.
    Its explicit output cap is reserved in full before each paid request, just
    like the other adapters. Provider-side usage/cache discounts never refund it.
    """

    name = "deepseek"
    path = "/v1/messages"

    def validate_input(self, model, messages):
        self.request_options(model)
        for message in messages:
            if any(part["type"] == "image" for part in message["content"]):
                if model != "deepseek-flash":
                    raise ModelError("The selected DeepSeek model does not support images; select deepseek-flash.")
                if message["role"] != "user":
                    raise ModelError("DeepSeek image inputs must be user messages.")

    def budget_input(self, *, messages, private, instructions, tools):
        try:
            self.validate_input(self.settings.model, messages)
        except ModelError as exc:
            # The owned loop rejects invalid budget inputs before reserving or
            # persisting a dispatch, while retaining its normal failure cleanup.
            raise ValueError(str(exc)) from None
        return super().budget_input(messages=messages, private=private, instructions=instructions, tools=tools)

    async def complete(self, *, model, instructions, messages, tools, max_output, private):
        self.validate_input(model, messages)
        if model != self.settings.model:
            raise ModelError("The requested DeepSeek model does not match its configured budget policy.")
        return await super().complete(model=model, instructions=instructions, messages=messages,
                                      tools=tools, max_output=max_output, private=private)

    def request_options(self, model):
        if model not in DEEPSEEK_MODELS:
            raise ModelError("Select a supported DeepSeek model: deepseek-flash or deepseek-v4-pro; retired aliases are not mapped.")
        return {"thinking": {"type": "disabled"}}

    def request_headers(self):
        return {"x-api-key": self.settings.model_api_key}


def create_model(settings) -> ModelAdapter:
    adapters = {"openai": OpenAIResponses, "anthropic": AnthropicMessages, "deepseek": DeepSeekMessages}
    if settings.model_provider not in adapters:
        raise ModelError("The configured model adapter is unavailable.")
    return adapters[settings.model_provider](settings)
