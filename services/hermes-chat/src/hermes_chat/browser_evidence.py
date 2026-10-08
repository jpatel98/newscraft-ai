"""Private, host-issued receipts for the isolated browser's rendered evidence.

This module is never a model tool. A tool result can name a receipt, but only
its sandbox host accessor can hand the actual sealed receipt to research.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import asdict, dataclass, field
from typing import Any

BROWSER_PROVENANCE = "newscraft_public_browser_v1"
BROWSER_FIXTURE_PROVENANCE = "newscraft_synthetic_browser_fixture_v1"
_RECEIPT_KEY = secrets.token_bytes(32)


@dataclass(frozen=True)
class BrowserReceipt:
    receipt_id: str
    tenant_key: str
    conversation_id: str
    run_id: str
    final_url: str
    rendered_text: str
    title: str
    text_sha256: str
    main_document_url: str
    main_document_sha256: str
    fetched_at: str
    validated_request_count: int
    navigation_id: str
    frame_id: str = "main"
    javascript_enabled: bool = True
    synthetic_fixture: bool = False
    public_network_validated: bool = True
    main_document_html: str = field(default="", repr=False)
    response_headers: tuple[tuple[str, str], ...] = ()
    provenance: str = BROWSER_PROVENANCE
    _seal: bytes = field(default=b"", repr=False, compare=False)

    @property
    def navigation_digest(self) -> str:
        payload = [self.tenant_key, self.conversation_id, self.run_id, self.navigation_id,
                   self.frame_id, self.final_url, self.main_document_url,
                   self.main_document_sha256, self.text_sha256]
        return hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _receipt_payload(receipt: BrowserReceipt) -> bytes:
    value = asdict(receipt)
    value.pop("_seal")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _issue_browser_receipt(**values: Any) -> BrowserReceipt:
    """Called only after the sandbox host validated a genuine main-frame read."""
    values.pop("_seal", None)
    text = values.get("rendered_text")
    if not isinstance(text, str):
        raise ValueError("browser receipt rendered text is required")
    digest = hashlib.sha256(text.encode()).hexdigest()
    if values.get("text_sha256", digest) != digest:
        raise ValueError("browser receipt text digest is invalid")
    values["text_sha256"] = digest
    fixture = values.get("synthetic_fixture", False)
    if not isinstance(fixture, bool):
        raise ValueError("browser fixture classification is invalid")
    values["provenance"] = BROWSER_FIXTURE_PROVENANCE if fixture else BROWSER_PROVENANCE
    if "response_headers" in values:
        headers = values["response_headers"]
        values["response_headers"] = tuple(headers.items()) if isinstance(headers, dict) else tuple(tuple(pair) for pair in headers)
    receipt = BrowserReceipt(**values)
    seal = hmac.digest(_RECEIPT_KEY, _receipt_payload(receipt), "sha256")
    object.__setattr__(receipt, "_seal", seal)
    return receipt


def _is_authentic_browser_receipt(receipt: object) -> bool:
    if type(receipt) is not BrowserReceipt:
        return False
    try:
        return hmac.compare_digest(receipt._seal, hmac.digest(_RECEIPT_KEY, _receipt_payload(receipt), "sha256"))
    except (TypeError, ValueError):
        return False
