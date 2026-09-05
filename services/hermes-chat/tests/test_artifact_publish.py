from __future__ import annotations

import hashlib
import asyncio
import base64
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_chat.artifact_publish import (
    ArtifactPublishError,
    publish_workspace_file,
    stage_backend_file,
    stage_workspace_file,
    upload_staged_file,
)
from hermes_chat.isolation import TenantRuntime


class ArtifactPublishTests(unittest.TestCase):
    def make_runtime(self, root: Path) -> TenantRuntime:
        workspace = root / "workspace"
        workspace.mkdir(mode=0o700)
        return TenantRuntime(
            key="tenant-test",
            hermes_home=root / "home",
            workspace=workspace,
            browser_profile=root / "profile",
            profile_name="newscraft-tenant-test",
            task_key="newscraft-tenant-test",
        )

    def test_stages_only_workspace_relative_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_runtime(Path(raw))
            target = runtime.workspace / "report.csv"
            payload = b"period,value\n2026-09-01,4.2\n"
            target.write_bytes(payload)
            staged, size, checksum = stage_workspace_file("/workspace/report.csv", runtime)
            self.assertEqual(size, len(payload))
            self.assertEqual(checksum, hashlib.sha256(payload).hexdigest())
            self.assertEqual(staged.read_bytes(), payload)
            self.assertTrue(staged.is_relative_to(runtime.hermes_home))
            self.assertFalse(staged.is_relative_to(runtime.workspace))
            staged.unlink(missing_ok=True)
            with self.assertRaises(ArtifactPublishError):
                stage_workspace_file("/workspace/../report.csv", runtime)

    def test_rejects_symlink_components(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_runtime(Path(raw))
            (runtime.workspace / "outside").mkdir()
            (runtime.workspace / "link").symlink_to(runtime.workspace / "outside", target_is_directory=True)
            with self.assertRaises(ArtifactPublishError):
                stage_workspace_file("/workspace/link/file.txt", runtime)

    def test_rejects_fifo_without_blocking_and_accepts_virtual_relative_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_runtime(Path(raw))
            fifo = runtime.workspace / "pipe"
            os.mkfifo(fifo, 0o600)
            with self.assertRaises(ArtifactPublishError):
                stage_workspace_file("/workspace/pipe", runtime)
            target = runtime.workspace / "nested.txt"
            target.write_bytes(b"ok")
            staged, size, _ = stage_workspace_file("nested.txt", runtime)
            self.assertEqual((size, staged.read_bytes()), (2, b"ok"))
            staged.unlink(missing_ok=True)

    def test_can_stage_from_a_non_host_backend_byte_reader(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_runtime(Path(raw))
            payload = b"backend bytes"

            class BackendFileOps:
                def read_file_bytes(self, path, *, max_bytes):
                    self.request = (path, max_bytes)
                    return SimpleNamespace(
                        file_size=len(payload),
                        base64_content=base64.b64encode(payload).decode("ascii"),
                        error=None,
                    )

            file_ops = BackendFileOps()
            staged, size, checksum = stage_backend_file(
                file_ops,
                "/workspace/chart.png",
                runtime,
                max_bytes=1024,
            )
            self.assertEqual(file_ops.request, ("/workspace/chart.png", 1024))
            self.assertEqual((staged.read_bytes(), size), (payload, len(payload)))
            self.assertEqual(checksum, hashlib.sha256(payload).hexdigest())
            self.assertTrue(staged.is_relative_to(runtime.hermes_home))
            self.assertFalse(staged.is_relative_to(runtime.workspace))
            staged.unlink(missing_ok=True)

    def test_can_stage_from_a_persistent_backend_workspace_mount(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            runtime = self.make_runtime(root)
            mounted_workspace = root / "docker" / "workspace"
            mounted_workspace.mkdir(parents=True, mode=0o700)
            payload = b"mounted bytes"
            (mounted_workspace / "chart.png").write_bytes(payload)
            staged, size, checksum = stage_workspace_file(
                "/workspace/chart.png",
                runtime,
                workspace_root=mounted_workspace,
            )
            self.assertEqual((staged.read_bytes(), size), (payload, len(payload)))
            self.assertEqual(checksum, hashlib.sha256(payload).hexdigest())
            staged.unlink(missing_ok=True)

    def test_publish_uses_backend_bytes_when_no_host_mount_is_exposed(self) -> None:
        payload = b"backend upload"
        checksum = hashlib.sha256(payload).hexdigest()

        class BackendFileOps:
            def read_file_bytes(self, _path, *, max_bytes):
                return SimpleNamespace(
                    file_size=len(payload),
                    base64_content=base64.b64encode(payload).decode("ascii"),
                    error=None,
                    max_bytes=max_bytes,
                )

        class Response:
            status_code = 200

            @staticmethod
            def json():
                return {"object_version": "version-backend-1234"}

        class Client:
            async def put(self, _url, *, headers, content):
                self.request = (headers, content)
                return Response()

        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_runtime(Path(raw))
            client = Client()
            grant = {
                "upload_url": "http://newscraft.test/upload",
                "max_bytes": len(payload),
            }
            with patch(
                "hermes_chat.artifact_publish._active_backend_for_task",
                return_value=(SimpleNamespace(_workspace_dir=None), BackendFileOps()),
            ):
                result = asyncio.run(publish_workspace_file(
                    client=client,
                    runtime=runtime,
                    path="/workspace/data.json",
                    grant=grant,
                    mime_type="application/json",
                    size=len(payload),
                    checksum_sha256=checksum,
                    task_id="tenant-task",
                ))
            self.assertEqual(result["object_version"], "version-backend-1234")
            self.assertEqual(client.request[1], payload)

    def test_async_upload_sends_bytes_not_a_sync_file_handle(self) -> None:
        class Response:
            status_code = 200

            @staticmethod
            def json():
                return {"object_version": "version-1234567890"}

        class Client:
            def __init__(self):
                self.payload = None

            async def put(self, _url, *, headers, content):
                self.payload = (headers, content)
                return Response()

        with tempfile.TemporaryDirectory() as raw:
            staged = Path(raw) / "staged.bin"
            staged.write_bytes(b"bytes")
            client = Client()
            result = asyncio.run(upload_staged_file(
                client,
                staged,
                "http://newscraft.test/upload",
                mime_type="text/csv",
                size=5,
                checksum_sha256=hashlib.sha256(b"bytes").hexdigest(),
            ))
            self.assertEqual(result["object_version"], "version-1234567890")
            self.assertEqual(client.payload[1], b"bytes")
            self.assertFalse(staged.exists())

    def test_rejects_boolean_upload_bounds(self) -> None:
        class Client:
            async def put(self, *_args, **_kwargs):
                raise AssertionError("the client must not receive an invalid upload")

        with tempfile.TemporaryDirectory() as raw:
            staged = Path(raw) / "staged.bin"
            staged.write_bytes(b"bytes")
            with self.assertRaises(ArtifactPublishError):
                asyncio.run(upload_staged_file(
                    Client(),
                    staged,
                    "http://newscraft.test/upload",
                    mime_type="text/csv",
                    size=True,
                    checksum_sha256=hashlib.sha256(b"bytes").hexdigest(),
                ))
            self.assertTrue(staged.exists())


if __name__ == "__main__":
    unittest.main()
