from __future__ import annotations

import base64
import json
import struct
import unittest
from unittest.mock import Mock
import zlib

from hermes_chat.input_messages import (
    InputMessageError,
    MAX_IMAGE_BYTES,
    MAX_IMAGES_PER_MESSAGE,
    MAX_IMAGES_PER_REQUEST,
    MAX_MESSAGE_PARTS,
    MAX_MESSAGE_WIRE_BYTES,
    MAX_REQUEST_WIRE_BYTES,
    MAX_TOTAL_IMAGE_BYTES,
    VISION_TOKEN_CEILINGS,
    convert_message_content,
    input_image_budget,
    input_token_upper_bound,
)


def chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)


def png(width: int = 2, height: int = 1, *, padding: int = 0) -> bytes:
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    pixels = (b"\0" + b"\0\xff\0" * width) * height
    metadata = chunk(b"tEXt", b"fixture\0" + b"x" * padding) if padding else b""
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + metadata + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def data_url(kind: str, data: bytes) -> str:
    return f"data:image/{kind};base64," + base64.b64encode(data).decode("ascii")


def ui_image(url: str, detail: str | None = None) -> dict:
    value = {"url": url}
    if detail is not None:
        value["detail"] = detail
    return {"type": "image_url", "image_url": value}


def payload(parts, role="user"):
    return {"model": "gpt-5.5", "input": [{"role": role, "content": parts}], "max_output_tokens": 256}


# Fixed raster fixtures; the tests require no decoders, providers, or network.
# The JPEG was exported from the locally generated 2x1 PNG by macOS ImageIO.
JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A7PwZ/wAifoX/AF4Wv/opa6Wua8Gf8ifoX/Xha/8Aopa6Wv4DPqD/2Q=="
)
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
WEBP = base64.b64decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89")


class InputMessageTests(unittest.TestCase):
    def setUp(self):
        self.url = data_url("png", png())

    def test_plain_text_and_empty_text_preserve_conversation_roles(self):
        for role in ("user", "assistant", "system", "developer"):
            with self.subTest(role=role):
                self.assertEqual(convert_message_content("Previous reply", role), "Previous reply")
                self.assertEqual(convert_message_content("", role), "")
        for role in ("tool", None, [], "USER"):
            with self.subTest(role=role), self.assertRaises(InputMessageError):
                convert_message_content("text", role)

    def test_exact_responses_mixed_payload_preserves_order(self):
        content = [{"type": "text", "text": "Explain this chart."}, ui_image(self.url), {"type": "text", "text": "Use its labels."}]
        converted = convert_message_content(content, "user")
        self.assertEqual(payload(converted), {
            "model": "gpt-5.5", "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "Explain this chart."},
                {"type": "input_image", "image_url": self.url, "detail": "high"},
                {"type": "input_text", "text": "Use its labels."},
            ]}], "max_output_tokens": 256,
        })
        self.assertEqual(content[1]["type"], "image_url")

    def test_image_only_messages_accept_supported_static_rasters(self):
        for kind, data in (("png", png()), ("jpeg", JPEG), ("gif", GIF), ("webp", WEBP)):
            with self.subTest(kind=kind):
                url = data_url(kind, data)
                self.assertEqual(convert_message_content([ui_image(url)], "user"), [{"type": "input_image", "image_url": url, "detail": "high"}])

    def test_explicit_image_details_and_canonical_content(self):
        for detail in ("low", "high", "auto", "original"):
            with self.subTest(detail=detail):
                expected = {"type": "input_image", "image_url": self.url, "detail": detail}
                self.assertEqual(convert_message_content([ui_image(self.url, detail)], "user"), [expected])
                self.assertEqual(convert_message_content([expected], "assistant"), [expected])
        self.assertEqual(convert_message_content([{"type": "input_text", "text": "Hello"}], "assistant"), [{"type": "input_text", "text": "Hello"}])

    def test_unsupported_sources_and_parts_are_explicitly_rejected(self):
        invalid = [
            ui_image("https://127.0.0.1/private?token=DO_NOT_ECHO"),
            ui_image("https://example.com/public.png"),
            ui_image("file:///private/tmp/image.png"),
            ui_image("data:image/svg+xml;base64,PHN2Zy8+"),
            {"type": "image_url", "image_url": self.url},
            {"type": "input_image", "file_id": "file-secret"},
            {"type": "input_image", "image_url": self.url, "file_id": "file-secret"},
            {"type": "input_file", "file_id": "file-secret"},
            {"type": "audio", "data": "secret"},
            {"type": "text", "text": "hello", "unknown": "secret"},
            {"type": "text", "text": 1},
            {"type": "image_url", "image_url": {"url": self.url, "unknown": "secret"}},
            ui_image(self.url, "invalid"),
            ui_image(self.url, 1),
            {}, {"type": []}, {"type": {}}, None, "hello",
        ]
        for part in invalid:
            with self.subTest(part=repr(part)[:80]), self.assertRaises(InputMessageError) as caught:
                convert_message_content([part], "user")
            self.assertNotIn("DO_NOT_ECHO", str(caught.exception))
            self.assertNotIn("file-secret", str(caught.exception))
        for content in (None, 1, {}, [], [None]):
            with self.subTest(content=content), self.assertRaises(InputMessageError):
                convert_message_content(content, "user")

    def test_malformed_base64_and_mime_header_mismatch_rejected(self):
        for url in (
            "data:image/png;base64,%%%%", "data:image/png;base64,A===",
            "data:image/png;base64,", "data:image/png;base64,AA==\n",
            "data:image/png;base64,AB==",  # Nonzero padding bits.
            data_url("jpeg", png()), data_url("png", GIF),
            "data:image/jpg;base64," + base64.b64encode(JPEG).decode(),
        ):
            with self.subTest(url=url[:40]), self.assertRaises(InputMessageError):
                convert_message_content([ui_image(url)], "user")

    def test_truncated_and_corrupt_container_headers_rejected(self):
        for kind, raw in (("png", png()), ("jpeg", JPEG), ("gif", GIF), ("webp", WEBP)):
            for bad in (raw[:8], raw[:-1], raw + b"trailing"):
                with self.subTest(kind=kind, size=len(bad)), self.assertRaises(InputMessageError):
                    convert_message_content([ui_image(data_url(kind, bad))], "user")
        corrupted = bytearray(png())
        corrupted[29] ^= 1
        with self.assertRaisesRegex(InputMessageError, "checksum"):
            convert_message_content([ui_image(data_url("png", bytes(corrupted)))], "user")
        for width, height in ((0, 1), (8193, 1), (8192, 2049)):
            raw = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", b"x") + chunk(b"IEND", b"")
            with self.subTest(dimensions=(width, height)), self.assertRaisesRegex(InputMessageError, "dimensions"):
                convert_message_content([ui_image(data_url("png", raw))], "user")

    def test_animated_rasters_rejected(self):
        raw_png = png()
        apng = raw_png[:33] + chunk(b"acTL", struct.pack(">II", 2, 0)) + raw_png[33:]
        first_frame = GIF[GIF.index(b",", 13):-1]
        animated_gif = GIF[:-1] + first_frame + b";"
        animated_webp = b"RIFF" + struct.pack("<I", 22) + b"WEBPVP8X" + struct.pack("<I", 10) + b"\x02" + b"\0" * 9
        for kind, raw in (("png", apng), ("gif", animated_gif), ("webp", animated_webp)):
            with self.subTest(kind=kind), self.assertRaisesRegex(InputMessageError, "Animated"):
                convert_message_content([ui_image(data_url(kind, raw))], "user")

    def test_header_only_webp_and_gif_without_palette_rejected(self):
        header_only = b"RIFF" + struct.pack("<I", 18) + b"WEBPVP8 " + struct.pack("<I", 10) + WEBP[20:30]
        no_palette = bytearray(GIF[:13] + GIF[19:])
        no_palette[10] &= 0x7f
        for kind, raw in (("webp", header_only), ("gif", bytes(no_palette))):
            with self.subTest(kind=kind), self.assertRaises(InputMessageError):
                convert_message_content([ui_image(data_url(kind, raw))], "user")

    def test_message_image_count_part_count_and_text_size_limits(self):
        converted = convert_message_content([ui_image(self.url)] * MAX_IMAGES_PER_MESSAGE, "user")
        self.assertEqual(len(converted), MAX_IMAGES_PER_MESSAGE)
        for content in ([ui_image(self.url)] * (MAX_IMAGES_PER_MESSAGE + 1), [{"type": "text", "text": ""}] * (MAX_MESSAGE_PARTS + 1), "é" * (MAX_MESSAGE_WIRE_BYTES // 2 + 1)):
            with self.subTest(kind=type(content).__name__), self.assertRaises(InputMessageError):
                convert_message_content(content, "user")

    def test_decoded_image_and_combined_message_wire_limits(self):
        oversized = data_url("png", png(padding=MAX_IMAGE_BYTES))
        with self.assertRaises(InputMessageError):
            convert_message_content([ui_image(oversized)], "user")
        medium = ui_image(data_url("png", png(padding=400 * 1024)))
        self.assertEqual(len(convert_message_content([medium], "user")), 1)
        with self.assertRaisesRegex(InputMessageError, "total input size"):
            convert_message_content([medium, medium], "user")

    def test_image_budget_counts_repeated_images_and_each_detail(self):
        parts = [{"type": "input_image", "image_url": self.url, "detail": detail} for detail in VISION_TOKEN_CEILINGS]
        parts.append({"type": "input_image", "image_url": self.url})
        budget = input_image_budget(payload(parts), "gpt-5.5")
        self.assertEqual(budget.count, 5)
        self.assertEqual(budget.decoded_bytes, 5 * len(png()))
        self.assertEqual(budget.wire_bytes, 5 * len(self.url))
        self.assertEqual(budget.tokens, sum(VISION_TOKEN_CEILINGS.values()) + VISION_TOKEN_CEILINGS["auto"])

    def test_only_reviewed_models_may_receive_images(self):
        content = convert_message_content([ui_image(self.url)], "user")
        for model in ("gpt-5.5", "gpt-5.5-2026-04-23"):
            with self.subTest(model=model):
                self.assertEqual(input_image_budget(payload(content), model).count, 1)
        for model in ("fixture", "gpt-5.5-custom", "gpt-5.5-2026-10-01", "gpt-4o"):
            with self.subTest(model=model), self.assertRaisesRegex(InputMessageError, "reviewed image-input budget"):
                input_image_budget(payload(content), model)
        self.assertEqual(input_image_budget(payload("Text only"), "custom").tokens, 0)

    def test_request_image_count_and_decoded_byte_limits(self):
        part = convert_message_content([ui_image(self.url)], "user")[0]
        self.assertEqual(input_image_budget(payload([part] * MAX_IMAGES_PER_REQUEST), "gpt-5.5").count, MAX_IMAGES_PER_REQUEST)
        with self.assertRaisesRegex(InputMessageError, "count or total byte"):
            input_image_budget(payload([part] * (MAX_IMAGES_PER_REQUEST + 1)), "gpt-5.5")
        raw = png(padding=550 * 1024)
        self.assertLess(len(raw), MAX_IMAGE_BYTES)
        large = {"type": "input_image", "image_url": data_url("png", raw), "detail": "high"}
        self.assertGreater(len(raw) * 4, MAX_TOTAL_IMAGE_BYTES)
        request = {"input": [{"role": "user", "content": [large]} for _ in range(4)]}
        with self.assertRaisesRegex(InputMessageError, "count or total byte"):
            input_image_budget(request, "gpt-5.5")

    def test_token_bound_substitutes_image_wire_for_vision_tokens(self):
        content = convert_message_content([{"type": "text", "text": "Read chart"}, ui_image(self.url)], "user")
        request = payload(content)
        wire = len(json.dumps(request, ensure_ascii=False).encode("utf-8"))
        self.assertEqual(input_token_upper_bound(request, "gpt-5.5"), wire - len(self.url) + 3001 + 1024)
        large_dimensions = data_url("png", png(width=8192))
        self.assertLess(len(large_dimensions), 1024)
        for detail, ceiling in VISION_TOKEN_CEILINGS.items():
            with self.subTest(detail=detail):
                request = payload(convert_message_content([ui_image(large_dimensions, detail)], "user"))
                self.assertGreaterEqual(input_token_upper_bound(request, "gpt-5.5"), ceiling + 1024)

    def test_literal_data_url_text_and_provider_output_are_counted_as_text(self):
        request = payload([{"type": "input_text", "text": self.url}])
        self.assertEqual(input_token_upper_bound(request, "custom"), len(json.dumps(request, ensure_ascii=False).encode()) + 1024)
        request["input"].append({"role": "assistant", "type": "message", "content": [{"type": "output_text", "text": "Earlier answer"}]})
        self.assertEqual(input_image_budget(request, "custom").count, 0)
        self.assertEqual(input_token_upper_bound(request, "custom"), len(json.dumps(request, ensure_ascii=False).encode()) + 1024)

    def test_unconverted_file_and_remote_input_cannot_bypass_budget_validation(self):
        for part in (ui_image(self.url), {"type": []}, {"type": "input_file", "file_id": "file-1"}, {"type": "input_image", "image_url": "http://127.0.0.1/image"}, {"type": "input_image", "image_url": self.url, "file_id": "file-1"}):
            with self.subTest(part=part["type"]), self.assertRaises(InputMessageError):
                input_token_upper_bound(payload([part]), "gpt-5.5")

    def test_total_request_wire_limit(self):
        with self.assertRaisesRegex(InputMessageError, "total payload size"):
            input_token_upper_bound(payload("x" * MAX_REQUEST_WIRE_BYTES), "custom")

    def test_multimodal_tool_and_computer_outputs_cannot_bypass_vision_guard(self):
        image = {"type": "input_image", "image_url": self.url, "detail": "auto"}
        items = [
            {"type": "function_call_output", "call_id": "call-1", "output": [image]},
            {"type": "custom_tool_call_output", "call_id": "call-1", "output": [image]},
            {"type": "computer_call_output", "call_id": "call-1", "output": {"type": "computer_screenshot", "image_url": self.url}},
            image,
            {"role": "user", "content": [{"type": "input_text", "text": "text", "unknown": {"type": "input_image", "image_url": self.url}}]},
        ]
        for item in items:
            for model in ("gpt-5.5", "unreviewed-model"):
                with self.subTest(item=item["type"] if "type" in item else "message", model=model), self.assertRaisesRegex(InputMessageError, "outside supported message"):
                    input_token_upper_bound({"input": [item]}, model)
        request = {"input": [{"type": "function_call_output", "call_id": "call-1", "output": json.dumps(image)}]}
        self.assertEqual(input_image_budget(request, "unreviewed-model").count, 0)
        self.assertEqual(input_token_upper_bound(request, "unreviewed-model"), len(json.dumps(request, ensure_ascii=False).encode()) + 1024)

    def test_validation_failure_prevents_model_invocation(self):
        model = Mock()
        def send(content, model_name="gpt-5.5"):
            request = payload(convert_message_content(content, "user"))
            input_token_upper_bound(request, model_name)
            model.complete(request)
        for content, model_name in (([ui_image("https://127.0.0.1/private")], "gpt-5.5"), ([ui_image(self.url)], "unreviewed-model")):
            with self.assertRaises(InputMessageError):
                send(content, model_name)
        model.complete.assert_not_called()


if __name__ == "__main__":
    unittest.main()
