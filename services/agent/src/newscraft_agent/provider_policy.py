"""Reviewed provider constraints, not automatic prices or billing guarantees.

DeepSeek's official pricing and retirement notices were checked 2026-10-07:
https://api-docs.deepseek.com/quick_start/pricing/
https://api-docs.deepseek.com/news/news260424/
Use peak cache-miss input and peak output rates; never assume a cache discount.
Operators must still supply explicit ceilings and recheck pricing before use.
"""

DEEPSEEK_PRICE_FLOORS = {
    "deepseek-flash": ("0.30", "1.20"),
    "deepseek-v4-pro": ("1.32", "3.96"),
}

# The Messages compatibility endpoint silently remaps unknown names. Reject
# retired aliases and other model IDs locally so model and billing stay explicit.
DEEPSEEK_MODELS = frozenset(DEEPSEEK_PRICE_FLOORS)
