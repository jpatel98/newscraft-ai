"""Conservative app-side reservations, not provider-enforced billing limits.

Reservations are never refunded: missing responses and usage records cannot
make a crashed request free. Operators supply reviewed price/image ceilings.
"""
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import asyncio
import json
import time

from .provider_policy import DEEPSEEK_PRICE_FLOORS


def policy(settings):
    return {"input_limit": settings.max_input_tokens, "output_per_call": settings.max_output_tokens,
            "seconds_limit": settings.max_seconds, "steps_limit": settings.max_iterations,
            "search_limit": getattr(settings, "max_search_calls", 5),
            "usd_limit": str(settings.max_cost_usd), "input_price": str(settings.input_cost_per_million),
            "output_price": str(settings.output_cost_per_million),
            "search_price": str(getattr(settings, "search_cost_ceiling_usd", 0)),
            "image_tokens": getattr(settings, "image_token_ceiling", 32768)}


def configured(settings, *, paid_search=False):
    try:
        prices = [Decimal(str(settings.input_cost_per_million)), Decimal(str(settings.output_cost_per_million))]
        if not all(price.is_finite() and price > 0 for price in prices):
            return False
        if getattr(settings, "model_provider", None) == "deepseek":
            floors = DEEPSEEK_PRICE_FLOORS.get(settings.model)
            if floors is None or any(price < Decimal(floor) for price, floor in zip(prices, floors)):
                return False
        if settings.web_provider == "openai" or paid_search:
            search = Decimal(str(getattr(settings, "search_cost_ceiling_usd", 0)))
            return search.is_finite() and search > 0
        return True
    except (InvalidOperation, ValueError):
        return False


FRAMING_TOKENS = 32  # Fixed request framing.
MESSAGE_FRAMING_TOKENS = 16  # Role/delimiter overhead per message.


def input_bound(adapter, *, messages, private, instructions, tools, image_tokens):
    """Reserve translated UTF-8 bytes, not an English-prose token average."""
    wire = adapter.budget_input(messages=messages, private=private, instructions=instructions, tools=tools)
    text = json.dumps(wire, ensure_ascii=False)
    images = [block for message in messages for block in message["content"] if block["type"] == "image"]
    for block in images:
        text = text.replace(block.get("data") or "\0", "", 1)
    return (len(text.encode("utf-8")) + FRAMING_TOKENS + MESSAGE_FRAMING_TOKENS * len(messages)
            + len(images) * image_tokens)


def reserve(state, settings, *, input_tokens=0, output_tokens=0, search=False):
    limits = policy(settings)
    charge = (Decimal(input_tokens) * Decimal(limits["input_price"]) +
              Decimal(output_tokens) * Decimal(limits["output_price"])) / 1_000_000
    if search:
        charge += Decimal(limits["search_price"])
    micros = int((charge * 1_000_000).to_integral_value(rounding=ROUND_CEILING))
    budget = state.setdefault("budget", {"input_tokens": 0, "output_tokens": 0, "cost_microusd": 0})
    if budget["input_tokens"] + input_tokens > limits["input_limit"]:
        raise ValueError("The cumulative input-token reservation budget was reached.")
    if Decimal(budget["cost_microusd"] + micros) > Decimal(limits["usd_limit"]) * 1_000_000:
        raise ValueError("The configured cost reservation budget was reached.")
    budget["input_tokens"] += input_tokens
    budget["output_tokens"] += output_tokens
    budget["cost_microusd"] += micros


def calls_left(state, settings, *, input_tokens, output_tokens):
    """How many more reservations of this size still fit the input-token and cost budgets."""
    limits = policy(settings)
    budget = state.get("budget") or {"input_tokens": 0, "cost_microusd": 0}
    charge = (Decimal(input_tokens) * Decimal(limits["input_price"]) +
              Decimal(output_tokens) * Decimal(limits["output_price"])) / 1_000_000
    micros = max(1, int((charge * 1_000_000).to_integral_value(rounding=ROUND_CEILING)))
    by_input = (limits["input_limit"] - budget["input_tokens"]) // max(1, input_tokens)
    by_cost = int((Decimal(limits["usd_limit"]) * 1_000_000 - budget["cost_microusd"]) // micros)
    return max(0, min(by_input, by_cost))


class BudgetedModel:
    """One auxiliary request's cumulative model budget, with no automatic replay."""

    def __init__(self, model, settings):
        self.model, self.settings = model, settings
        self.state, self.steps = {}, 0
        self.deadline = time.monotonic() + settings.max_seconds

    async def complete(self, **arguments):
        if not configured(self.settings) or arguments.get("model") != self.settings.model:
            raise ValueError("Reviewed model price ceilings are required.")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0 or self.steps >= self.settings.max_iterations:
            raise ValueError("The auxiliary model request budget was reached.")
        arguments["max_output"] = min(arguments["max_output"], self.settings.max_output_tokens)
        bound = input_bound(self.model, messages=arguments["messages"], private=arguments["private"],
                            instructions=arguments["instructions"], tools=arguments["tools"],
                            image_tokens=policy(self.settings)["image_tokens"])
        reserve(self.state, self.settings, input_tokens=bound, output_tokens=arguments["max_output"])
        self.steps += 1
        async with asyncio.timeout(remaining):
            return await self.model.complete(**arguments)
