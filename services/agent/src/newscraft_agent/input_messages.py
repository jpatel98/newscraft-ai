"""Validate NewsCraft attachments and convert them to Responses message content.

No URL is fetched and no credential or SDK is needed here. Raster headers and
containers are checked locally; the provider still performs its image decode.
Protocol/budget source: https://developers.openai.com/api/docs/guides/images-vision
Reviewed against GPT-5.5 patch budgets and its 1.2 token multiplier.
"""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import json
import re
import struct
from typing import Any, Mapping
import zlib


MAX_IMAGE_BYTES = 800 * 1024
MAX_MESSAGE_WIRE_BYTES = 950 * 1024
MAX_MESSAGE_PARTS = 32
MAX_IMAGES_PER_MESSAGE = 8
MAX_IMAGES_PER_REQUEST = 16
MAX_TOTAL_IMAGE_BYTES = 2 * 1024 * 1024
MAX_REQUEST_WIRE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_SIDE = 8192
MAX_IMAGE_PIXELS = 16 * 1024 * 1024
VISION_MODELS = frozenset({"gpt-5.5", "gpt-5.5-2026-04-23"})
# Includes one token for the documented floating-point rounding variance.
VISION_TOKEN_CEILINGS = {"low": 309, "high": 3001, "auto": 12001, "original": 12001}
_DATA_URL = re.compile(r"data:image/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})\Z")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class InputMessageError(ValueError):
    """An attachment cannot be safely represented as a supported model input."""


@dataclass(frozen=True)
class ImageInputBudget:
    count: int = 0
    decoded_bytes: int = 0
    wire_bytes: int = 0
    tokens: int = 0


def _dimensions(width: int, height: int) -> None:
    if not (0 < width <= MAX_IMAGE_SIDE and 0 < height <= MAX_IMAGE_SIDE
            and width * height <= MAX_IMAGE_PIXELS):
        raise InputMessageError("Image dimensions exceed the supported attachment limits; resize the image.")


def _png(data: bytes) -> None:
    if not data.startswith(_PNG_SIGNATURE):
        raise InputMessageError("Image MIME type does not match its PNG header.")
    offset, header, pixels = 8, False, False
    color = None
    palette = False
    while offset + 12 <= len(data):
        size = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            break
        body = data[offset + 8:end - 4]
        if zlib.crc32(kind + body) & 0xffffffff != int.from_bytes(data[end - 4:end], "big"):
            raise InputMessageError("PNG attachment has an invalid chunk checksum.")
        if not header:
            if kind != b"IHDR" or size != 13:
                break
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            _dimensions(width, height)
            allowed = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            if depth not in allowed.get(color, set()) or compression or filtering or interlace not in {0, 1}:
                break
            header = True
        elif kind == b"IHDR":
            break
        elif kind in {b"acTL", b"fcTL", b"fdAT"}:
            raise InputMessageError("Animated image attachments are unsupported; attach a single frame.")
        elif kind == b"PLTE":
            if pixels or not 0 < size <= 768 or size % 3:
                break
            palette = True
        elif kind == b"IDAT":
            pixels = pixels or size > 0
        elif kind == b"IEND":
            if size == 0 and pixels and (color != 3 or palette) and end == len(data):
                return
            break
        offset = end
    raise InputMessageError("PNG attachment is truncated or has invalid image headers.")


def _jpeg(data: bytes) -> None:
    if not data.startswith(b"\xff\xd8"):
        raise InputMessageError("Image MIME type does not match its JPEG header.")
    offset, frame, scan, entropy = 2, False, False, False
    frames = {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf}
    while offset < len(data):
        if data[offset] != 0xff:
            break
        while offset < len(data) and data[offset] == 0xff:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker == 0xd9:
            if frame and scan and entropy and offset == len(data):
                return
            break
        if marker in {0x00, 0xd8} or 0xd0 <= marker <= 0xd7:
            break
        if marker == 0x01:
            continue
        if offset + 2 > len(data):
            break
        size = int.from_bytes(data[offset:offset + 2], "big")
        end = offset + size
        if size < 2 or end > len(data):
            break
        body = data[offset + 2:end]
        if marker in frames:
            if frame or len(body) < 6 or len(body) != 6 + 3 * body[5] or body[0] != 8 or body[5] not in {1, 3, 4}:
                break
            _dimensions(int.from_bytes(body[3:5], "big"), int.from_bytes(body[1:3], "big"))
            frame = True
        offset = end
        if marker == 0xda:
            if not frame or len(body) < 6 or len(body) != 4 + 2 * body[0] or not 1 <= body[0] <= 4:
                break
            scan = True
            while offset < len(data):
                if data[offset] != 0xff:
                    entropy = True
                    offset += 1
                elif offset + 1 < len(data) and (data[offset + 1] == 0 or 0xd0 <= data[offset + 1] <= 0xd7):
                    entropy = True
                    offset += 2
                else:
                    break
    raise InputMessageError("JPEG attachment is truncated or has invalid image headers.")


def _gif(data: bytes) -> None:
    if len(data) < 13 or data[:6] not in {b"GIF87a", b"GIF89a"}:
        raise InputMessageError("Image MIME type does not match its GIF header.")
    width, height = struct.unpack("<HH", data[6:10])
    _dimensions(width, height)
    packed = data[10]
    offset = 13 + (3 * (1 << ((packed & 7) + 1)) if packed & 0x80 else 0)
    frames = 0

    def blocks(start: int) -> int:
        while start < len(data):
            size = data[start]
            start += 1
            if size == 0:
                return start
            start += size
            if start > len(data):
                break
        raise InputMessageError("GIF attachment has truncated data blocks.")

    while offset < len(data):
        marker = data[offset]
        offset += 1
        if marker == 0x3b:
            if frames == 1 and offset == len(data):
                return
            break
        if marker == 0x21:
            if offset >= len(data):
                break
            offset = blocks(offset + 1)
        elif marker == 0x2c:
            frames += 1
            if frames > 1:
                raise InputMessageError("Animated GIF attachments are unsupported; attach a single frame.")
            if offset + 9 > len(data):
                break
            x, y, frame_width, frame_height, flags = struct.unpack("<HHHHB", data[offset:offset + 9])
            if not frame_width or not frame_height or x + frame_width > width or y + frame_height > height:
                break
            offset += 9 + (3 * (1 << ((flags & 7) + 1)) if flags & 0x80 else 0)
            if not (packed & 0x80 or flags & 0x80):
                break
            if offset + 1 >= len(data) or not 2 <= data[offset] <= 8 or not data[offset + 1]:
                break
            offset = blocks(offset + 1)
        else:
            break
    raise InputMessageError("GIF attachment is truncated or has invalid image headers.")


def _webp(data: bytes) -> None:
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP" or int.from_bytes(data[4:8], "little") + 8 != len(data):
        raise InputMessageError("Image MIME type does not match a complete WebP container.")
    offset, image, canvas = 12, None, None
    while offset + 8 <= len(data):
        kind = data[offset:offset + 4]
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        end = offset + 8 + size
        if end + (size & 1) > len(data):
            break
        body = data[offset + 8:end]
        if kind in {b"ANIM", b"ANMF"} or (kind == b"VP8X" and body and body[0] & 2):
            raise InputMessageError("Animated WebP attachments are unsupported; attach a single frame.")
        if kind == b"VP8X":
            if size != 10 or canvas is not None or body[0] & 0xc1 or body[1:4] != b"\x00\x00\x00":
                break
            canvas = (1 + int.from_bytes(body[4:7], "little"), 1 + int.from_bytes(body[7:10], "little"))
            _dimensions(*canvas)
        elif kind in {b"VP8 ", b"VP8L"}:
            if image is not None:
                break
            if kind == b"VP8 " and size > 10 and not body[0] & 1 and body[3:6] == b"\x9d\x01\x2a":
                image = (int.from_bytes(body[6:8], "little") & 0x3fff, int.from_bytes(body[8:10], "little") & 0x3fff)
            elif kind == b"VP8L" and size > 5 and body[0] == 0x2f:
                bits = int.from_bytes(body[1:5], "little")
                if bits >> 29:
                    break
                image = (1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff))
            else:
                break
            _dimensions(*image)
        offset = end + (size & 1)
    if offset == len(data) and image is not None and (canvas is None or canvas == image):
        return
    raise InputMessageError("WebP attachment is truncated or has invalid image headers.")


def _image(url: Any, detail: Any) -> tuple[dict[str, Any], int]:
    if not isinstance(detail, str) or detail not in VISION_TOKEN_CEILINGS:
        raise InputMessageError("Image detail must be low, high, original, or auto.")
    if not isinstance(url, str) or len(url) > 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 64:
        raise InputMessageError("Image attachment exceeds 800 KiB or has an invalid inline URL.")
    match = _DATA_URL.fullmatch(url)
    if not match:
        raise InputMessageError("Image attachments require inline base64 JPEG, PNG, WebP, or static GIF data; remote URLs and file references are unsupported.")
    try:
        data = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error):
        raise InputMessageError("Image attachment contains invalid base64 data.") from None
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise InputMessageError("Image attachment must contain at most 800 KiB of image data.")
    if base64.b64encode(data).decode("ascii") != match[2]:
        raise InputMessageError("Image attachment contains noncanonical base64 data.")
    {"png": _png, "jpeg": _jpeg, "gif": _gif, "webp": _webp}[match[1]](data)
    return {"type": "input_image", "image_url": url, "detail": detail}, len(data)


def convert_message_content(content: Any, role: str) -> str | list[dict[str, Any]]:
    """Preserve message order and image-only messages; reject unsupported input."""
    if not isinstance(role, str) or role not in {"user", "assistant", "system", "developer"}:
        raise InputMessageError("Message role is unsupported.")
    if isinstance(content, str):
        if len(content.encode("utf-8")) > MAX_MESSAGE_WIRE_BYTES:
            raise InputMessageError("Message exceeds the supported input size.")
        return content
    if not isinstance(content, list) or not content or len(content) > MAX_MESSAGE_PARTS:
        raise InputMessageError("Message content must be text or a bounded list of supported parts.")
    result: list[dict[str, Any]] = []
    count = 0
    for part in content:
        if not isinstance(part, dict):
            raise InputMessageError("Message content contains an invalid part.")
        kind = part.get("type")
        if not isinstance(kind, str):
            raise InputMessageError("Message content part type must be a supported string.")
        if kind in {"text", "input_text"}:
            if set(part) != {"type", "text"} or not isinstance(part.get("text"), str):
                raise InputMessageError("Text input must contain only its type and text.")
            result.append({"type": "input_text", "text": part["text"]})
        elif kind == "image_url":
            image = part.get("image_url")
            if set(part) != {"type", "image_url"} or not isinstance(image, dict) or set(image) - {"url", "detail"} or "url" not in image:
                raise InputMessageError("Image input must contain an inline URL and optional supported detail.")
            converted, _ = _image(image["url"], image.get("detail", "high"))
            result.append(converted)
            count += 1
        elif kind == "input_image":
            if set(part) - {"type", "image_url", "detail"} or "image_url" not in part:
                raise InputMessageError("Image file references and unknown image fields are unsupported.")
            converted, _ = _image(part["image_url"], part.get("detail", "high"))
            result.append(converted)
            count += 1
        else:
            raise InputMessageError("Unsupported message content part; only text and inline raster images are accepted.")
    if count > MAX_IMAGES_PER_MESSAGE:
        raise InputMessageError("Message contains too many image attachments.")
    if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_MESSAGE_WIRE_BYTES:
        raise InputMessageError("Message attachments exceed the supported total input size.")
    return result


def input_image_budget(payload: Mapping[str, Any], model: str) -> ImageInputBudget:
    """Validate every image occurrence and expose the conservative vision reserve."""
    count = decoded = wire = tokens = 0
    unsupported_contexts: list[Any] = []
    for message in payload.get("input", []):
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        is_message = isinstance(role, str) and role in {"user", "assistant", "system", "developer"} and message.get("type", "message") == "message"
        if not is_message or not isinstance(message.get("content"), list):
            unsupported_contexts.append(message)
            continue
        unsupported_contexts.extend(value for key, value in message.items() if key != "content")
        for part in message["content"]:
            if isinstance(part, dict) and not isinstance(part.get("type"), str):
                raise InputMessageError("Model content part type must be a supported string.")
            if isinstance(part, dict) and part.get("type") in {"image_url", "input_file", "file", "image"}:
                raise InputMessageError("Model image inputs must be converted inline image parts; remote and file references are unsupported.")
            if not isinstance(part, dict) or part.get("type") != "input_image":
                unsupported_contexts.append(part)
                continue
            if not isinstance(model, str) or model not in VISION_MODELS:
                raise InputMessageError("This model has no reviewed image-input budget; choose the supported vision model.")
            if set(part) - {"type", "image_url", "detail"} or "image_url" not in part:
                raise InputMessageError("Unsupported image source or fields in model input.")
            _, size = _image(part["image_url"], part.get("detail", "auto"))
            count += 1
            decoded += size
            wire += len(part["image_url"].encode("utf-8"))
            tokens += VISION_TOKEN_CEILINGS[part.get("detail", "auto")]
    # Tool outputs are strings in the owned loop. Fail closed if a later caller
    # supplies multimodal tool/computer output instead of silently undercounting.
    image_types = {"input_image", "image_url", "input_file", "file", "image", "computer_screenshot"}
    while unsupported_contexts:
        value = unsupported_contexts.pop()
        if isinstance(value, dict):
            kind = value.get("type")
            if isinstance(kind, str) and kind in image_types:
                raise InputMessageError("Images and files outside supported message content are unsupported.")
            unsupported_contexts.extend(value.values())
        elif isinstance(value, list):
            unsupported_contexts.extend(value)
    if count > MAX_IMAGES_PER_REQUEST or decoded > MAX_TOTAL_IMAGE_BYTES:
        raise InputMessageError("Conversation image inputs exceed the supported count or total byte limit.")
    return ImageInputBudget(count, decoded, wire, tokens)


def input_token_upper_bound(payload: Mapping[str, Any], model: str) -> int:
    """Text/schema byte bound plus image token ceilings, without counting base64 as text.

    Image wire bytes are removed only after field and raster validation. Literal
    data URLs in input_text remain ordinary text and retain their full bound.
    """
    budget = input_image_budget(payload, model)
    wire = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    if wire > MAX_REQUEST_WIRE_BYTES:
        raise InputMessageError("Model input exceeds the supported total payload size.")
    return wire - budget.wire_bytes + budget.tokens + 1024
