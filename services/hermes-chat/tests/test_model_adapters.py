from __future__ import annotations

import copy
import json
import unittest
from decimal import Decimal
from math import ceil
from types import SimpleNamespace

import httpx

from hermes_chat import budgets
from hermes_chat.model_adapters import DeepSeekMessages, ModelError, create_model
from test_input_messages import data_url, png


class DeepSeekAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = SimpleNamespace(
            model_provider="deepseek", model="deepseek-flash", model_api_key="synthetic-deepseek-key",
            model_base_url="https://api.deepseek.com/anthropic", max_seconds=180, max_iterations=8,
            max_input_tokens=120000, max_output_tokens=2048, max_cost_usd=0.06,
            input_cost_per_million=0.30, output_cost_per_million=1.20, web_provider="public",
        )
        self.requests = []
        self.clients = []
        self.messages = [{"role": "user", "content": [{"type": "text", "text": "Check a source."}]}]
        self.tools = [{"name": "read", "description": "Read public evidence",
                       "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}]

    async def asyncTearDown(self):
        for client in self.clients:
            await client.aclose()

    def adapter(self, replies):
        queue = list(replies)

        def respond(request):
            self.requests.append(request)
            reply = queue.pop(0)
            if isinstance(reply, BaseException):
                raise reply
            return reply if isinstance(reply, httpx.Response) else httpx.Response(200, json=reply)

        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        self.clients.append(client)
        return DeepSeekMessages(self.settings, client=client)

    async def complete(self, adapter, **overrides):
        arguments = dict(model=self.settings.model, instructions="Owned system policy", messages=self.messages,
                         tools=self.tools, max_output=2048, private={})
        return await adapter.complete(**(arguments | overrides))

    async def test_messages_wire_round_trip_preserves_tools_and_omits_foreign_fields(self):
        adapter = self.adapter([
            {"stop_reason": "tool_use", "content": [
                {"type": "thinking", "thinking": "PRIVATE_REASONING", "signature": "PRIVATE_SIGNATURE"},
                {"type": "tool_use", "id": "read-1", "name": "read", "input": {"url": "https://example.test/source"}},
            ], "usage": {"input_tokens": 8, "output_tokens": 12, "cache_read_input_tokens": 900}},
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": "A sourced answer. [1]"}]},
        ])
        reply = await self.complete(adapter)
        self.assertEqual(reply.usage, {"input_tokens": 8, "output_tokens": 12})
        self.assertEqual(reply.private, {})
        self.assertEqual(reply.message["content"], [{"type": "tool_call", "id": "read-1", "name": "read",
                                                   "arguments": {"url": "https://example.test/source"}}])
        messages = self.messages + [reply.message, {"role": "tool", "content": [
            {"type": "tool_result", "id": "read-1", "output": "untrusted source text", "failed": False}]}]
        final = await self.complete(adapter, messages=messages, private=reply.private)
        self.assertEqual(final.message["content"], [{"type": "text", "text": "A sourced answer. [1]"}])
        for request in self.requests:
            self.assertEqual(str(request.url), "https://api.deepseek.com/anthropic/v1/messages")
            self.assertEqual(request.headers["x-api-key"], "synthetic-deepseek-key")
            self.assertNotIn("authorization", request.headers)
            body = json.loads(request.content)
            self.assertEqual(set(body), {"model", "max_tokens", "thinking", "system", "messages", "tools"})
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["max_tokens"], 2048)
            self.assertEqual(body["tools"][0]["input_schema"], self.tools[0]["parameters"])
            self.assertNotIn("PRIVATE_", request.content.decode())
        continuation = json.loads(self.requests[-1].content)["messages"]
        self.assertEqual(continuation[-2]["content"][0]["id"], "read-1")
        self.assertEqual(continuation[-1]["content"][0]["tool_use_id"], "read-1")
        self.assertEqual(continuation[-1]["content"][0]["content"], "untrusted source text")

    async def test_retired_or_unknown_names_never_reach_silent_provider_mapping(self):
        adapter = self.adapter([])
        for model in ("deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "claude-opus", "unknown"):
            with self.subTest(model=model), self.assertRaisesRegex(ModelError, "supported DeepSeek model"):
                await self.complete(adapter, model=model)
        self.assertEqual(self.requests, [])

    async def test_flash_images_preserve_wire_input_and_have_a_conservative_reservation(self):
        encoded = data_url("png", png()).split(",", 1)[1]
        messages = [{"role": "user", "content": [
            {"type": "text", "text": "Read this screenshot."},
            {"type": "image", "media_type": "image/png", "data": encoded}]}]
        adapter = self.adapter([{"stop_reason": "end_turn", "content": [{"type": "text", "text": "An image."}]}])
        private = {"replay": {"0": "PRIVATE_OTHER_PROVIDER_STATE"}}
        bound = budgets.input_bound(adapter, messages=messages, private=private,
                                    instructions="Owned system policy", tools=self.tools, image_tokens=32768)
        self.assertGreater(bound, 32768)
        state = {}
        budgets.reserve(state, self.settings, input_tokens=bound, output_tokens=2048)
        await self.complete(adapter, messages=messages, private=private)
        body = json.loads(self.requests[0].content)
        self.assertEqual(body["messages"][0]["content"][1], {
            "type": "image", "source": {"type": "base64", "media_type": "image/png", "data": encoded}})
        self.assertNotIn("PRIVATE_OTHER_PROVIDER_STATE", self.requests[0].content.decode())
        expected_micros = ceil(Decimal(bound) * Decimal("0.30") + Decimal(2048) * Decimal("1.20"))
        self.assertEqual(state["budget"]["cost_microusd"], expected_micros)

    async def test_pro_images_fail_before_reservation_or_dispatch(self):
        self.settings.model = "deepseek-v4-pro"
        self.settings.input_cost_per_million = 1.32
        self.settings.output_cost_per_million = 3.96
        self.assertTrue(budgets.configured(self.settings))
        image = {"type": "image", "media_type": "image/png", "data": data_url("png", png()).split(",", 1)[1]}
        messages = [{"role": "user", "content": [image]}]
        adapter = self.adapter([])
        with self.assertRaisesRegex(ValueError, "does not support images"):
            budgets.input_bound(adapter, messages=messages, private={},
                                instructions="Owned system policy", tools=self.tools, image_tokens=32768)
        with self.assertRaisesRegex(ModelError, "does not support images"):
            await self.complete(adapter, messages=messages)
        self.assertEqual(self.requests, [])

    async def test_flash_rejects_images_in_non_user_messages_before_dispatch(self):
        adapter = self.adapter([])
        image = {"type": "image", "media_type": "image/png", "data": data_url("png", png()).split(",", 1)[1]}
        for role in ("assistant", "system", "tool"):
            messages = [{"role": role, "content": [image]}]
            with self.subTest(role=role), self.assertRaisesRegex(ModelError, "must be user messages"):
                await self.complete(adapter, messages=messages)
        self.assertEqual(self.requests, [])

    async def test_explicit_model_cannot_bypass_the_configured_model_price_policy(self):
        adapter = self.adapter([])
        with self.assertRaisesRegex(ModelError, "does not match its configured budget policy"):
            await self.complete(adapter, model="deepseek-v4-pro")
        self.assertEqual(self.requests, [])

    async def test_incomplete_responses_and_malformed_tool_calls_fail_closed(self):
        invalid = [
            {"stop_reason": "max_tokens", "content": [{"type": "text", "text": "truncated"}]},
            {"stop_reason": "end_turn", "content": {}},
            {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "read", "id": "id", "input": "{}"}]},
            {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "read", "id": "", "input": {}}]},
        ]
        adapter = self.adapter(invalid)
        for response in invalid:
            with self.subTest(response=response), self.assertRaises(ModelError):
                await self.complete(adapter)
        self.assertEqual(len(self.requests), len(invalid))

    async def test_provider_failures_never_retry_or_echo_private_details(self):
        for failure in (httpx.ReadTimeout("PRIVATE_PROVIDER_DETAIL"),
                        httpx.Response(429, text="PRIVATE_PROVIDER_DETAIL"),
                        httpx.Response(200, text="PRIVATE_PROVIDER_DETAIL")):
            with self.subTest(failure=type(failure).__name__):
                before = len(self.requests)
                adapter = self.adapter([failure])
                with self.assertRaises(ModelError) as raised:
                    await self.complete(adapter)
                self.assertNotIn("PRIVATE_PROVIDER_DETAIL", str(raised.exception))
                self.assertEqual(len(self.requests), before + 1)

    def test_factory_selects_dedicated_adapter(self):
        self.assertIsInstance(create_model(self.settings), DeepSeekMessages)
        self.assertEqual(create_model(self.settings).name, "deepseek")

    def test_peak_reservations_fit_six_cent_acceptance_cap_without_refunds(self):
        self.assertTrue(budgets.configured(self.settings))
        state = {}
        for _ in range(8):
            budgets.reserve(state, self.settings, input_tokens=15000, output_tokens=2048)
        # Round each admitted request UP to microdollars, not the total down.
        self.assertEqual(state["budget"], {"input_tokens": 120000, "output_tokens": 16384, "cost_microusd": 55664})
        self.assertLess(Decimal(state["budget"]["cost_microusd"]) / 1_000_000, Decimal("0.06"))
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, "input-token"):
            budgets.reserve(state, self.settings, input_tokens=1, output_tokens=2048)
        self.assertEqual(state, before)

    def test_pro_uses_its_own_peak_floors_and_unknown_models_fail_closed(self):
        self.settings.model = "deepseek-v4-pro"
        self.assertFalse(budgets.configured(self.settings))
        self.settings.input_cost_per_million = 1.32
        self.settings.output_cost_per_million = 3.96
        self.assertTrue(budgets.configured(self.settings))
        self.settings.model = "deepseek-reasoner"
        self.assertFalse(budgets.configured(self.settings))

    def test_nonfinite_or_discounted_prices_cannot_enable_dispatch(self):
        for name, value in (("input_cost_per_million", 0.006), ("input_cost_per_million", 0.15),
                            ("output_cost_per_million", 0.6), ("input_cost_per_million", float("inf")),
                            ("output_cost_per_million", float("nan"))):
            with self.subTest(setting=name, value=value):
                previous = getattr(self.settings, name)
                setattr(self.settings, name, value)
                self.assertFalse(budgets.configured(self.settings))
                setattr(self.settings, name, previous)
