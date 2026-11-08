import asyncio
import copy
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from newscraft_agent import budgets
from newscraft_agent.model_adapters import ModelError, OpenAIResponses


class BudgetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = SimpleNamespace(model_provider="openai", model="fixture", web_provider="public",
            max_seconds=10, max_iterations=2, max_input_tokens=10000, max_output_tokens=256,
            max_cost_usd=1, input_cost_per_million=1, output_cost_per_million=1,
            search_cost_ceiling_usd=0)
        self.model = OpenAIResponses(self.settings)
        self.model.complete = AsyncMock(return_value="fixture reply")
        self.arguments = {"model": "fixture", "instructions": "policy", "tools": [], "private": {},
            "messages": [{"role": "user", "content": [{"type": "text", "text": "untrusted claim"}]}], "max_output": 900}

    def test_paid_page_search_requires_an_explicit_finite_positive_ceiling(self):
        for price in (0, -1, float("nan"), float("inf")):
            with self.subTest(price=price):
                self.settings.search_cost_ceiling_usd = price
                self.assertFalse(budgets.configured(self.settings, paid_search=True))
        for price in (0.02, 0.1):
            with self.subTest(positive_price=price):
                self.settings.search_cost_ceiling_usd = price
                self.assertTrue(budgets.configured(self.settings, paid_search=True))
        self.settings.search_cost_ceiling_usd = 0.02
        self.settings.max_cost_usd = 0.04
        state = {}
        budgets.reserve(state, self.settings, search=True)
        self.assertEqual(state["budget"]["cost_microusd"], 20000)
        budgets.reserve(state, self.settings, search=True)
        self.assertEqual(state["budget"]["cost_microusd"], 40000)
        with self.assertRaisesRegex(ValueError, "cost reservation budget"):
            budgets.reserve(state, self.settings, search=True)
        self.assertEqual(state["budget"]["cost_microusd"], 40000)
        self.model.complete.assert_not_awaited()

    def test_nonprose_and_multibyte_input_cannot_reduce_the_token_reservation(self):
        for content in ("!@#$%^&*()" * 500, "𐐀新闻é" * 500, "aQ7/_+9-" * 500):
            with self.subTest(content=content[:10]):
                arguments = {**self.arguments, "messages": [{"role": "user", "content": [{"type": "text", "text": content}]}]}
                bound = budgets.input_bound(self.model, **{key: arguments[key] for key in ("messages", "instructions", "tools", "private")}, image_tokens=32768)
                self.assertGreaterEqual(bound, len(content.encode("utf-8")))

    async def test_auxiliary_calls_share_a_cumulative_budget_and_clamp_output(self):
        limited = budgets.BudgetedModel(self.model, self.settings)
        await limited.complete(**self.arguments)
        reserved = copy.deepcopy(limited.state["budget"])
        self.assertEqual(self.model.complete.await_args.kwargs["max_output"], 256)
        await limited.complete(**self.arguments)
        self.assertEqual(limited.state["budget"], {key: value * 2 for key, value in reserved.items()})
        with self.assertRaisesRegex(ValueError, "budget"):
            await limited.complete(**self.arguments)
        self.assertEqual(self.model.complete.await_count, 2)

    async def test_auxiliary_price_input_and_cost_limits_precede_dispatch(self):
        for key, value in (("input_cost_per_million", 0), ("max_input_tokens", 1), ("max_cost_usd", 0.000001)):
            with self.subTest(key=key):
                original = getattr(self.settings, key)
                setattr(self.settings, key, value)
                with self.assertRaises(ValueError):
                    await budgets.BudgetedModel(self.model, self.settings).complete(**self.arguments)
                setattr(self.settings, key, original)
        self.model.complete.assert_not_awaited()

    async def test_auxiliary_uncertain_calls_are_not_retried_or_refunded(self):
        self.model.complete.side_effect = ModelError("uncertain")
        limited = budgets.BudgetedModel(self.model, self.settings)
        with self.assertRaises(ModelError):
            await limited.complete(**self.arguments)
        self.assertGreater(limited.state["budget"]["cost_microusd"], 0)
        self.model.complete.assert_awaited_once()

    async def test_auxiliary_request_timeout_cancels_the_model(self):
        stopped = asyncio.Event()
        async def wait(**arguments):
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        self.model.complete.side_effect = wait
        self.settings.max_seconds = 0.01
        with self.assertRaises(TimeoutError):
            await budgets.BudgetedModel(self.model, self.settings).complete(**self.arguments)
        self.assertTrue(stopped.is_set())
