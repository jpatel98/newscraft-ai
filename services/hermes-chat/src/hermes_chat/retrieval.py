"""NewsCraft's provider-neutral web extraction and lead verification backend.

The backend uses one bounded live request for a candidate page. It falls back
to one Wayback CDX lookup and one Wayback replay request only when the live
page is blocked or unreadable. It never bypasses a challenge or a paywall.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import re
import socket
import base64
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from http.client import HTTPResponse
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:  # Hermes is present in the pinned runtime, but not in NewsCraft unit tests.
    from agent.web_search_provider import WebSearchProvider
except ImportError:  # pragma: no cover - exercised only without Hermes installed.
    class WebSearchProvider:  # type: ignore[no-redef]
        pass


logger = logging.getLogger(__name__)

PROVIDER_NAME = "newscraft-local"
VERIFY_LEAD_TOOL_NAME = "verify_this_lead"
WAYBACK_CDX_URL = "https://web.archive.org/cdx/search/cdx"
WAYBACK_REPLAY_ROOT = "https://web.archive.org/web"
DEFAULT_USER_AGENT = "NewsCraft/1.0 (+https://newscraft.ai; source-verification)"
MAX_RESPONSE_BYTES = 5_000_000
MIN_CONTENT_CHARS = 220
MIN_CONTENT_WORDS = 35
MAX_EXTRACT_CHARS = 60_000

_BLOCKED_STATUS = {401, 403, 407, 409, 425, 429, 451}
_CHALLENGE_MARKERS = (
    "access denied",
    "captcha",
    "cf-chl-",
    "checking your browser",
    "enable javascript and cookies",
    "just a moment",
    "robot check",
    "verify you are human",
    "verify you are a human",
)
_PAYWALL_MARKERS = (
    re.compile(r"\b(?:please\s+)?subscribe\s+to\s+(?:continue|read|access|unlock)\b"),
    re.compile(r"\b(?:subscription|membership)\s+(?:is\s+)?required\s+to\s+(?:read|access|continue|view)\b"),
    re.compile(r"\b(?:sign|log)\s+in\s+to\s+(?:continue|read|access|view)\b"),
    re.compile(
        r"\b(?:this|the)\s+(?:article|story|content)\s+is\s+(?:available|accessible)\s+only\s+to\s+subscribers?\b"
    ),
)
_SENSITIVE_QUERY_KEYS = re.compile(
    r"(?:token|secret|password|credential|session|auth|api[_-]?key|access[_-]?key|signature|sig)",
    re.IGNORECASE,
)
_ARTICLE_TYPES = {
    "article",
    "blogposting",
    "newsarticle",
    "report",
    "analysisnewsarticle",
}
_LIVE_TYPES = {"liveblogposting", "liveblog"}
_SKIP_TAGS = {"aside", "footer", "form", "nav", "noscript", "script", "style", "svg", "template"}
_BLOCK_TAGS = {
    "article",
    "br",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "main",
    "p",
    "section",
    "tr",
}


@dataclass(frozen=True)
class RetrievalConfig:
    enabled: bool = True
    live_timeout_ms: int = 8_000
    archive_timeout_ms: int = 6_000
    max_urls: int = 5
    archive_fallback: bool = True

    @classmethod
    def from_env(cls) -> "RetrievalConfig":
        return cls(
            enabled=_bool_setting("NEWSCRAFT_RETRIEVAL_ENABLED", True),
            live_timeout_ms=_integer_setting("NEWSCRAFT_RETRIEVAL_LIVE_TIMEOUT_MS", 8_000, 2_000, 30_000),
            archive_timeout_ms=_integer_setting(
                "NEWSCRAFT_RETRIEVAL_ARCHIVE_TIMEOUT_MS", 6_000, 2_000, 30_000
            ),
            max_urls=_integer_setting("NEWSCRAFT_RETRIEVAL_MAX_URLS", 5, 1, 5),
            archive_fallback=_bool_setting("NEWSCRAFT_RETRIEVAL_ARCHIVE_FALLBACK", True),
        )


@dataclass(frozen=True)
class HttpResponse:
    status: int
    url: str
    headers: Mapping[str, str]
    body: bytes = b""
    error: str | None = None


@dataclass(frozen=True)
class ArchiveCapture:
    timestamp: str
    original_url: str
    archived_url: str
    mimetype: str
    status_code: int


@dataclass(frozen=True)
class ParsedPage:
    title: str
    content: str
    published_at: str | None
    updated_at: str | None
    page_timestamp: str | None
    page_type: str
    extraction_method: str
    content_type: str


def _bool_setting(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "true" if default else "false").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false")


def _integer_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _hostname_is_private(hostname: str) -> bool:
    lowered = hostname.strip(".").lower()
    if lowered in {"localhost", "localhost.localdomain"} or lowered.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(lowered)
    except ValueError:
        return False
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def validate_public_url(value: str) -> str:
    """Validate an outbound URL without resolving or contacting it."""
    candidate = value.strip()
    parsed = urlsplit(candidate)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("url must be an HTTP or HTTPS URL")
    if parsed.username or parsed.password:
        raise ValueError("url credentials are not allowed")
    if any(_SENSITIVE_QUERY_KEYS.search(key) for key in parse_qs(parsed.query, keep_blank_values=True)):
        raise ValueError("url contains a sensitive query parameter")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("url port is invalid") from exc
    if _hostname_is_private(parsed.hostname):
        raise ValueError("private or local URLs are not allowed")
    return candidate


class _PublicRedirectHandler(HTTPRedirectHandler):
    # Keep a single page read bounded even when a source returns a redirect chain.
    max_redirections = 5

    def redirect_request(
        self,
        req: Request,
        fp: HTTPResponse,
        code: int,
        msg: str,
        headers: Mapping[str, str],
        newurl: str,
    ) -> Request | None:
        validate_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _read_response(response: HTTPResponse) -> bytes:
    return response.read(MAX_RESPONSE_BYTES + 1)[:MAX_RESPONSE_BYTES]


def default_fetch(url: str, timeout_seconds: float) -> HttpResponse:
    """Fetch one public URL with one bounded request and no retry."""
    try:
        validate_public_url(url)
        request = Request(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.2",
                "User-Agent": DEFAULT_USER_AGENT,
            },
        )
        with build_opener(_PublicRedirectHandler()).open(request, timeout=timeout_seconds) as response:
            return HttpResponse(
                status=int(response.status),
                url=response.geturl(),
                headers={key.lower(): value for key, value in response.headers.items()},
                body=_read_response(response),
            )
    except HTTPError as exc:
        try:
            body = _read_response(exc)
        except Exception:
            body = b""
        return HttpResponse(
            status=int(exc.code),
            url=exc.geturl() or url,
            headers={key.lower(): value for key, value in exc.headers.items()},
            body=body,
            error="http_error",
        )
    except (TimeoutError, socket.timeout):
        return HttpResponse(status=0, url=url, headers={}, error="timeout")
    except (URLError, OSError, ValueError):
        return HttpResponse(status=0, url=url, headers={}, error="network_error")


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.json_ld: list[str] = []
        self._text: list[str] = []
        self._title: list[str] = []
        self._h1: list[str] = []
        self._skip_depth = 0
        self._title_depth = 0
        self._h1_depth = 0
        self._json_depth = 0
        self._json_buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attributes = {key.lower(): value or "" for key, value in attrs}
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            if tag == "script" and "json" in attributes.get("type", "").lower():
                self._json_depth = self._skip_depth
                self._json_buffer = []
            return
        if self._skip_depth:
            self._skip_depth += 1
            return
        if tag == "meta":
            key = attributes.get("name") or attributes.get("property") or attributes.get("itemprop")
            content = attributes.get("content")
            if key and content:
                self.meta[key.strip().lower()] = content.strip()
        if tag == "title":
            self._title_depth += 1
        if tag == "h1":
            self._h1_depth += 1
        if tag in _BLOCK_TAGS:
            self._text.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._skip_depth:
            if tag == "script" and self._json_depth == self._skip_depth:
                if self._json_buffer:
                    self.json_ld.append("".join(self._json_buffer))
                self._json_buffer = []
                self._json_depth = 0
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag == "title":
            self._title_depth = max(0, self._title_depth - 1)
        if tag == "h1":
            self._h1_depth = max(0, self._h1_depth - 1)
        if tag in _BLOCK_TAGS:
            self._text.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            if self._json_depth:
                self._json_buffer.append(data)
            return
        text = data.strip()
        if not text:
            return
        self._text.append(text)
        if self._title_depth:
            self._title.append(text)
        if self._h1_depth:
            self._h1.append(text)

    @property
    def visible_text(self) -> str:
        return _clean_text(" ".join(self._text))

    @property
    def title(self) -> str:
        return _clean_text(" ".join(self._title))

    @property
    def h1(self) -> str:
        return _clean_text(" ".join(self._h1))


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _provenance_marker(metadata: Mapping[str, object]) -> str:
    """Keep provenance across Hermes's pinned result-shaping wrapper.

    Hermes trims provider metadata before it returns ``web_extract`` results.
    The HTML comment is machine-readable, does not become page evidence, and
    lets NewsCraft persist the audit record after the tool result returns.
    """
    payload = json.dumps(dict(metadata), ensure_ascii=True, separators=(",", ":"))
    encoded = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")
    return f"<!-- newscraft-retrieval:v1:{encoded} -->"


def _walk_json(value: object) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    if isinstance(value, dict):
        found.append(value)
        for child in value.values():
            found.extend(_walk_json(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_walk_json(child))
    return found


def _json_ld_records(values: Sequence[str]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for value in values:
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            continue
        records.extend(_walk_json(parsed))
    return records


def _string_field(record: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _type_names(record: Mapping[str, object]) -> set[str]:
    raw = record.get("@type")
    values = raw if isinstance(raw, list) else [raw]
    return {str(value).strip().lower().replace(" ", "") for value in values if value}


def _parse_timestamp(value: str | None) -> tuple[str, datetime] | None:
    if not value:
        return None
    candidate = value.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", candidate):
            parsed = datetime.fromisoformat(candidate).replace(tzinfo=timezone.utc)
        else:
            parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            parsed = parsed.astimezone(timezone.utc)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(candidate)
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ"), parsed


def _timestamp_from_records(records: Sequence[Mapping[str, object]], *keys: str) -> str | None:
    for record in records:
        parsed = _parse_timestamp(_string_field(record, *keys))
        if parsed:
            return parsed[0]
    return None


def _decode_body(response: HttpResponse) -> str:
    content_type = response.headers.get("content-type", "")
    charset = re.search(r"charset=([\w-]+)", content_type, re.IGNORECASE)
    encoding = charset.group(1) if charset else "utf-8"
    try:
        return response.body.decode(encoding, errors="replace")
    except LookupError:
        return response.body.decode("utf-8", errors="replace")


def parse_page(response: HttpResponse) -> ParsedPage:
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type and content_type not in {"text/html", "application/xhtml+xml", "application/xml", "text/xml"}:
        return ParsedPage(
            title="",
            content="",
            published_at=None,
            updated_at=None,
            page_timestamp=None,
            page_type="unknown",
            extraction_method="unsupported_content_type",
            content_type=content_type,
        )

    parser = _PageParser()
    try:
        parser.feed(_decode_body(response))
        parser.close()
    except Exception:
        return ParsedPage(
            title="",
            content="",
            published_at=None,
            updated_at=None,
            page_timestamp=None,
            page_type="unknown",
            extraction_method="html_parse_error",
            content_type=content_type or "text/html",
        )

    records = _json_ld_records(parser.json_ld)
    article_records = [record for record in records if _type_names(record) & (_ARTICLE_TYPES | _LIVE_TYPES)]
    body_candidates = [_string_field(record, "articleBody", "text") or "" for record in article_records]
    body_candidates = [_clean_text(value) for value in body_candidates if _clean_text(value)]
    visible = parser.visible_text
    content = max(body_candidates + [visible], key=len, default="")
    title = (
        _string_field(article_records[0], "headline", "name") if article_records else None
    ) or parser.h1 or parser.title or parser.meta.get("og:title") or parser.meta.get("twitter:title") or ""
    published = _timestamp_from_records(records, "datePublished", "dateCreated")
    updated = _timestamp_from_records(records, "dateModified", "dateUpdated")
    published = published or next(
        (
            parsed[0]
            for key in ("article:published_time", "datepublished", "publishdate", "date", "dc.date")
            if (parsed := _parse_timestamp(parser.meta.get(key)))
        ),
        None,
    )
    updated = updated or next(
        (
            parsed[0]
            for key in ("article:modified_time", "datemodified", "last-modified")
            if (parsed := _parse_timestamp(parser.meta.get(key)))
        ),
        None,
    )
    updated = updated or next(
        (parsed[0] for parsed in (_parse_timestamp(response.headers.get("last-modified")),) if parsed),
        None,
    )
    page_timestamp = updated or published

    parsed_url = urlsplit(response.url)
    path = parsed_url.path.rstrip("/").lower()
    query = parse_qs(parsed_url.query)
    if any(key in query for key in ("q", "query", "search")) or "/search" in path:
        page_type = "search"
    elif path in {"", "/"}:
        page_type = "homepage"
    elif re.search(r"/(?:category|categories|tag|tags|topic|topics|archive|archives)(?:/|$)", path):
        page_type = "category"
    elif any(_type_names(record) & _LIVE_TYPES for record in records):
        page_type = "official_live"
    elif article_records or (page_timestamp and len(content) >= MIN_CONTENT_CHARS):
        page_type = "article"
    elif len(content) >= MIN_CONTENT_CHARS:
        page_type = "hub"
    else:
        page_type = "unknown"

    methods = []
    if body_candidates:
        methods.append("jsonld_article_body")
    if visible:
        methods.append("html_text")
    if parser.meta:
        methods.append("html_metadata")
    return ParsedPage(
        title=_clean_text(title),
        content=content[:MAX_EXTRACT_CHARS],
        published_at=published,
        updated_at=updated,
        page_timestamp=page_timestamp,
        page_type=page_type,
        extraction_method="+".join(methods) or "none",
        content_type=content_type or "text/html",
    )


def _capture_timestamp_iso(value: str) -> str | None:
    if not re.fullmatch(r"\d{14}", value):
        return None
    try:
        return datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    except ValueError:
        return None


def _expected_timestamp(kwargs: Mapping[str, object], url: str) -> str | None:
    values = kwargs.get("expected_timestamps")
    if isinstance(values, Mapping):
        value = values.get(url)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("expected_timestamp", "timestamp", "publicationDate", "publication_date"):
        value = kwargs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _timestamp_status(expected: str | None, actual: str | None) -> tuple[str, str | None]:
    if actual is None:
        return "unknown", "unknown_timestamp"
    if expected is None:
        return "observed", None
    expected_parsed = _parse_timestamp(expected)
    actual_parsed = _parse_timestamp(actual)
    if not expected_parsed or not actual_parsed:
        return "mismatch", "timestamp_mismatch"
    if expected_parsed[1].date() != actual_parsed[1].date():
        return "mismatch", "timestamp_mismatch"
    return "matched", None


def _challenge_reason(response: HttpResponse) -> str | None:
    if response.error == "timeout":
        return "live_timeout"
    if response.error == "network_error":
        return "live_network_error"
    if response.status in _BLOCKED_STATUS:
        return f"live_blocked_http_{response.status}"
    if response.status >= 400:
        return f"live_http_{response.status}"
    body = _decode_body(response).lower()
    if len(body) < 10_000 and any(marker.search(body) for marker in _PAYWALL_MARKERS):
        return "live_paywall"
    if len(body) < 10_000 and any(marker in body for marker in _CHALLENGE_MARKERS):
        return "live_blocked_challenge"
    return None


def _decode_cdx(response: HttpResponse) -> list[ArchiveCapture]:
    if response.status != 200:
        return []
    try:
        parsed = json.loads(_decode_body(response))
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list) or not parsed:
        return []
    header: list[str] | None = None
    rows = parsed
    if isinstance(parsed[0], list) and all(isinstance(value, str) for value in parsed[0]):
        header = [str(value) for value in parsed[0]]
        rows = parsed[1:]
    if not header:
        return []
    captures: list[ArchiveCapture] = []
    for raw in rows:
        if not isinstance(raw, list):
            continue
        values = {header[index]: raw[index] for index in range(min(len(header), len(raw)))}
        timestamp = str(values.get("timestamp", ""))
        original_url = str(values.get("original", ""))
        mimetype = str(values.get("mimetype", ""))
        try:
            status_code = int(str(values.get("statuscode", "0")))
        except ValueError:
            status_code = 0
        if not _capture_timestamp_iso(timestamp) or not original_url or status_code != 200:
            continue
        if mimetype and not mimetype.lower().startswith(("text/html", "application/xhtml")):
            continue
        archived_url = f"{WAYBACK_REPLAY_ROOT}/{timestamp}/{quote(original_url, safe=':/?&=#%')}"
        captures.append(
            ArchiveCapture(
                timestamp=timestamp,
                original_url=original_url,
                archived_url=archived_url,
                mimetype=mimetype,
                status_code=status_code,
            )
        )
    return captures


class NewsCraftWebProvider(WebSearchProvider):
    """Local, no-key Hermes extraction backend with a Wayback fallback."""

    def __init__(
        self,
        config: RetrievalConfig | None = None,
        *,
        fetcher: Callable[[str, float], HttpResponse] = default_fetch,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.config = config or RetrievalConfig.from_env()
        self.fetcher = fetcher
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    @property
    def display_name(self) -> str:
        return "NewsCraft local extraction"

    def is_available(self) -> bool:
        return self.config.enabled

    def supports_search(self) -> bool:
        return False

    def supports_extract(self) -> bool:
        return True

    def get_setup_schema(self) -> dict[str, object]:
        return {
            "name": self.display_name,
            "badge": "local",
            "tag": "No API key. Uses direct HTTP extraction with Wayback fallback.",
            "env_vars": [],
        }

    def _capture(self, url: str, expected: str | None) -> ArchiveCapture | None:
        params: list[tuple[str, str]] = [
            ("url", url),
            ("output", "json"),
            ("fl", "timestamp,original,mimetype,statuscode,digest"),
            ("filter", "statuscode:200"),
            ("filter", "mimetype:text/html"),
            ("limit", "1"),
        ]
        if expected:
            parsed = _parse_timestamp(expected)
            if parsed:
                params.append(("closest", parsed[1].strftime("%Y%m%d%H%M%S")))
        else:
            params.append(("fastLatest", "true"))
        cdx_url = f"{WAYBACK_CDX_URL}?{urlencode(params)}"
        response = self.fetcher(cdx_url, self.config.archive_timeout_ms / 1000)
        captures = _decode_cdx(response)
        return captures[0] if captures else None

    def _metadata(
        self,
        original_url: str,
        response: HttpResponse,
        retrieval_time: str,
        request_count: int,
        *,
        mode: str,
        archived_url: str | None = None,
        capture_timestamp: str | None = None,
        fallback_reason: str | None = None,
        live_status: int | None = None,
    ) -> dict[str, object]:
        return {
            "backend": PROVIDER_NAME,
            "originalUrl": original_url,
            "retrievedUrl": response.url or original_url,
            "archivedUrl": archived_url,
            "captureTimestamp": capture_timestamp,
            "retrievalTime": retrieval_time,
            "retrievalMode": mode,
            "fallbackReason": fallback_reason,
            "liveStatus": live_status if live_status is not None else response.status or None,
            "retrievedStatus": response.status or None,
            "requestCount": request_count,
        }

    def verify_lead(
        self,
        url: str,
        *,
        expected_timestamp: str | None = None,
        expected_title: str | None = None,
        expected_snippet: str | None = None,
    ) -> dict[str, object]:
        """Verify one search lead in one bounded operation."""
        original_url = url.strip()
        retrieval_time = self.clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            validate_public_url(original_url)
        except ValueError as exc:
            metadata = {
                "backend": PROVIDER_NAME,
                "originalUrl": original_url,
                "retrievalTime": retrieval_time,
                "retrievalMode": "none",
                "requestCount": 0,
                "evidenceStatus": "rejected",
                "rejectionReason": "invalid_url",
                "detail": str(exc),
            }
            return {"url": original_url, "title": original_url, "content": "", "raw_content": "", "metadata": metadata, "error": "invalid_url"}

        live = self.fetcher(original_url, self.config.live_timeout_ms / 1000)
        request_count = 1
        live_reason = _challenge_reason(live)
        if live_reason is None:
            parsed = parse_page(live)
            result = self._evaluate(
                original_url,
                live,
                parsed,
                retrieval_time,
                request_count,
                expected_timestamp,
                expected_title,
                expected_snippet,
                mode="live",
            )
            return result

        if not self.config.archive_fallback:
            return self._failure(
                original_url,
                live,
                retrieval_time,
                request_count,
                live_reason,
                mode="live",
            )

        capture = self._capture(original_url, expected_timestamp)
        request_count += 1
        if capture is None:
            return self._failure(
                original_url,
                live,
                retrieval_time,
                request_count,
                "archive_miss",
                mode="archive",
                fallback_reason=live_reason,
            )

        archived = self.fetcher(capture.archived_url, self.config.archive_timeout_ms / 1000)
        request_count += 1
        archived_reason = _challenge_reason(archived)
        if archived_reason is not None:
            return self._failure(
                original_url,
                archived,
                retrieval_time,
                request_count,
                "archive_unreadable",
                mode="archive",
                archived_url=capture.archived_url,
                capture_timestamp=_capture_timestamp_iso(capture.timestamp),
                fallback_reason=live_reason,
                live_status=live.status,
            )
        parsed = parse_page(archived)
        return self._evaluate(
            original_url,
            archived,
            parsed,
            retrieval_time,
            request_count,
            expected_timestamp,
            expected_title,
            expected_snippet,
            mode="archive",
            archived_url=capture.archived_url,
            capture_timestamp=_capture_timestamp_iso(capture.timestamp),
            fallback_reason=live_reason,
            live_status=live.status,
        )

    def _evaluate(
        self,
        original_url: str,
        response: HttpResponse,
        parsed: ParsedPage,
        retrieval_time: str,
        request_count: int,
        expected_timestamp: str | None,
        expected_title: str | None,
        expected_snippet: str | None,
        *,
        mode: str,
        archived_url: str | None = None,
        capture_timestamp: str | None = None,
        fallback_reason: str | None = None,
        live_status: int | None = None,
    ) -> dict[str, object]:
        metadata = self._metadata(
            original_url,
            response,
            retrieval_time,
            request_count,
            mode=mode,
            archived_url=archived_url,
            capture_timestamp=capture_timestamp,
            fallback_reason=fallback_reason,
            live_status=live_status,
        )
        metadata.update(
            {
                "pageTimestamp": parsed.page_timestamp,
                "publishedAt": parsed.published_at,
                "updatedAt": parsed.updated_at,
                "pageQuality": parsed.page_type,
                "pageType": parsed.page_type,
                "extractionMethod": parsed.extraction_method,
                "timestampStatus": _timestamp_status(expected_timestamp, parsed.page_timestamp)[0],
                "contentHash": hashlib.sha256(parsed.content.encode("utf-8")).hexdigest(),
            }
        )
        reason: str | None = None
        if len(parsed.content) < MIN_CONTENT_CHARS or len(parsed.content.split()) < MIN_CONTENT_WORDS:
            reason = "snippet_only"
        elif parsed.page_type not in {"article", "official_live"}:
            reason = "page_quality"
        else:
            _, reason = _timestamp_status(expected_timestamp, parsed.page_timestamp)
        if reason:
            metadata.update({"evidenceStatus": "rejected", "rejectionReason": reason})
            marker = _provenance_marker(metadata)
            return {
                "url": original_url,
                "title": parsed.title or original_url,
                "content": marker,
                "raw_content": marker,
                "metadata": metadata,
                "error": reason,
            }
        metadata["evidenceStatus"] = "accepted"
        metadata["rejectionReason"] = None
        metadata["titleMatch"] = bool(not expected_title or _clean_text(expected_title) in parsed.title)
        metadata["snippetCompared"] = bool(expected_snippet)
        marker = _provenance_marker(metadata)
        return {
            "url": original_url,
            "title": parsed.title or original_url,
            "content": f"{parsed.content}\n\n{marker}",
            "raw_content": f"{parsed.content}\n\n{marker}",
            "metadata": metadata,
        }

    def _failure(
        self,
        original_url: str,
        response: HttpResponse,
        retrieval_time: str,
        request_count: int,
        reason: str,
        *,
        mode: str,
        archived_url: str | None = None,
        capture_timestamp: str | None = None,
        fallback_reason: str | None = None,
        live_status: int | None = None,
    ) -> dict[str, object]:
        metadata = self._metadata(
            original_url,
            response,
            retrieval_time,
            request_count,
            mode=mode,
            archived_url=archived_url,
            capture_timestamp=capture_timestamp,
            fallback_reason=fallback_reason,
            live_status=live_status,
        )
        metadata.update({"evidenceStatus": "unreadable", "rejectionReason": reason})
        marker = _provenance_marker(metadata)
        return {
            "url": original_url,
            "title": original_url,
            "content": marker,
            "raw_content": marker,
            "metadata": metadata,
            "error": reason,
        }

    def extract(self, urls: Sequence[str], **kwargs: object) -> list[dict[str, object]]:
        """Return one normalized result per unique URL for Hermes to wrap."""
        if not isinstance(urls, Sequence) or isinstance(urls, (str, bytes)):
            return [self._failure("", HttpResponse(0, "", {}), self.clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), 0, "invalid_url", mode="none")]
        if len(urls) == 0:
            return [self._failure("", HttpResponse(0, "", {}), self.clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), 0, "empty_url_list", mode="none")]
        if len(urls) > self.config.max_urls:
            return [self._failure("", HttpResponse(0, "", {}), self.clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), 0, "url_limit_exceeded", mode="none")]
        results = []
        seen_urls: set[str] = set()
        for value in urls:
            if not isinstance(value, str):
                results.append({"url": "", "title": "", "content": "", "raw_content": "", "metadata": {"evidenceStatus": "rejected", "rejectionReason": "invalid_url"}, "error": "invalid_url"})
                continue
            url = value.strip()
            if url in seen_urls:
                continue
            seen_urls.add(url)
            results.append(
                self.verify_lead(
                    url,
                    expected_timestamp=_expected_timestamp(kwargs, url),
                    expected_title=kwargs.get("expected_title") if isinstance(kwargs.get("expected_title"), str) else None,
                    expected_snippet=kwargs.get("expected_snippet") if isinstance(kwargs.get("expected_snippet"), str) else None,
                )
            )
        return results


_ACTIVE_PROVIDER: NewsCraftWebProvider | None = None

VERIFY_LEAD_TOOL_SCHEMA: dict[str, object] = {
    "name": VERIFY_LEAD_TOOL_NAME,
    "description": (
        "Verify one candidate page from a search lead. Fetch the URL, compare its "
        "publication or update timestamp when supplied, classify page quality, and "
        "return normalized evidence or an explicit rejection reason. A search snippet "
        "is never evidence."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The candidate HTTP or HTTPS page URL from web_search.",
            },
            "expected_timestamp": {
                "type": "string",
                "description": "The publication or update timestamp reported by web_search, when available.",
            },
            "expected_title": {
                "type": "string",
                "description": "The candidate title reported by web_search, when available.",
            },
            "expected_snippet": {
                "type": "string",
                "description": "The candidate search snippet, used only for comparison and never as evidence.",
            },
        },
        "required": ["url"],
        "additionalProperties": False,
    },
}


def _optional_argument(args: Mapping[str, object], name: str) -> str | None:
    value = args.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _tool_provider() -> NewsCraftWebProvider:
    if _ACTIVE_PROVIDER is not None:
        return _ACTIVE_PROVIDER
    try:
        from agent.web_search_registry import get_provider

        provider = get_provider(PROVIDER_NAME)
        if isinstance(provider, NewsCraftWebProvider):
            return provider
    except Exception:
        pass
    return NewsCraftWebProvider()


def verify_this_lead(args: Mapping[str, object], **_kwargs: object) -> str:
    """Hermes plugin handler for one bounded candidate-page verification."""
    url = _optional_argument(args, "url")
    if not url:
        result: dict[str, object] = {
            "url": "",
            "title": "",
            "content": "",
            "raw_content": "",
            "metadata": {
                "backend": PROVIDER_NAME,
                "originalUrl": "",
                "retrievalMode": "none",
                "requestCount": 0,
                "evidenceStatus": "rejected",
                "rejectionReason": "invalid_url",
            },
            "error": "invalid_url",
        }
    else:
        result = _tool_provider().verify_lead(
            url,
            expected_timestamp=_optional_argument(args, "expected_timestamp"),
            expected_title=_optional_argument(args, "expected_title"),
            expected_snippet=_optional_argument(args, "expected_snippet"),
        )
    return json.dumps(
        {"operation": VERIFY_LEAD_TOOL_NAME, "results": [result]},
        ensure_ascii=True,
        separators=(",", ":"),
    )


def register(ctx: object) -> None:
    """Hermes pip-plugin entry point."""
    global _ACTIVE_PROVIDER
    register_web_search_provider = getattr(ctx, "register_web_search_provider", None)
    if not callable(register_web_search_provider):
        raise TypeError("Hermes plugin context cannot register web providers")
    provider = NewsCraftWebProvider()
    _ACTIVE_PROVIDER = provider
    register_web_search_provider(provider)
    register_tool = getattr(ctx, "register_tool", None)
    if callable(register_tool):
        register_tool(
            name=VERIFY_LEAD_TOOL_NAME,
            toolset="hermes-acp",
            schema=VERIFY_LEAD_TOOL_SCHEMA,
            handler=verify_this_lead,
            check_fn=provider.is_available,
            description="Verify one web search lead with source timestamps and bounded archive fallback.",
        )


def retrieval_readiness(config: RetrievalConfig | None = None) -> dict[str, object]:
    """Return a no-network readiness report for the Hermes service."""
    active = config or RetrievalConfig.from_env()
    base = {
        "enabled": active.enabled,
        "backend": PROVIDER_NAME if active.enabled else None,
        "liveTimeoutMs": active.live_timeout_ms,
        "archiveTimeoutMs": active.archive_timeout_ms,
        "maxUrls": active.max_urls,
        "archiveFallback": active.archive_fallback,
        "archiveProvider": "wayback" if active.archive_fallback else None,
    }
    if not active.enabled:
        return {**base, "configured": False, "reason": "disabled"}
    try:
        from agent.web_search_registry import get_provider

        provider = get_provider(PROVIDER_NAME)
        if provider is None:
            return {**base, "configured": False, "reason": "plugin_not_registered"}
        if not provider.supports_extract():
            return {**base, "configured": False, "reason": "extract_capability_missing"}
        if not provider.is_available():
            return {**base, "configured": False, "reason": "provider_unavailable"}
    except ImportError:
        return {**base, "configured": False, "reason": "hermes_registry_unavailable"}
    except Exception:
        return {**base, "configured": False, "reason": "provider_readiness_error"}
    return {**base, "configured": True, "reason": None}
