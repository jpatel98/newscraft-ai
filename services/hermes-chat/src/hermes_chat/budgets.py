"""Conservative app-side reservations, not provider-enforced billing limits.

Reservations are never refunded: missing responses and usage records cannot
make a crashed request free. Operators supply reviewed price/image ceilings.
"""
from decimal import Decimal, ROUND_CEILING
import json


def policy(settings):
    return {"input_limit": settings.max_input_tokens, "output_per_call": settings.max_output_tokens,
            "seconds_limit": settings.max_seconds, "steps_limit": settings.max_iterations,
            "search_limit": getattr(settings, "max_search_calls", 5),
            "usd_limit": str(settings.max_cost_usd), "input_price": str(settings.input_cost_per_million),
            "output_price": str(settings.output_cost_per_million),
            "search_price": str(getattr(settings, "search_cost_ceiling_usd", 0)),
            "image_tokens": getattr(settings, "image_token_ceiling", 32768)}


def configured(settings):
    return (settings.input_cost_per_million > 0 and settings.output_cost_per_million > 0
            and (settings.web_provider != "openai" or getattr(settings, "search_cost_ceiling_usd", 0) > 0))


def input_bound(adapter, *, messages, private, instructions, tools, image_tokens):
    # Count the actual translated input, including strict schemas and encrypted
    # continuation. One token per UTF-8 byte plus framing is deliberately high.
    wire = adapter.budget_input(messages=messages, private=private, instructions=instructions, tools=tools)
    images = sum(block["type"] == "image" for message in messages for block in message["content"])
    return len(json.dumps(wire, ensure_ascii=False).encode()) + 1024 + 64 * len(messages) + images * image_tokens


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
