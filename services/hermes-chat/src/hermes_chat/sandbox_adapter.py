"""Small execution boundary; no Docker daemon or cloud harness is implicit.

A rootless OCI executor can be configured on a suitable Linux worker. Provider
selection stays outside the canonical model/tool loop. Artifact rendering itself
does not require a code executor. No host execution fallback is permitted.
"""
from typing import Any, Protocol


class SandboxAdapter(Protocol):
    def schemas(self) -> list[dict[str, Any]]: ...
    async def execute(self, name: str, arguments: dict[str, Any], *, operation_id: str) -> dict[str, Any]: ...
    async def cancel(self) -> bool: ...  # True only after scoped execution is terminal.
    async def close(self) -> None: ...


class UnconfiguredSandbox:
    policy = {"kind": "unconfigured"}

    def __init__(self, runtime, thread_id, run_id):
        self.scope = (runtime.key, thread_id, run_id)

    def schemas(self):
        return []

    async def execute(self, name, arguments, *, operation_id):
        raise RuntimeError("Code execution is not configured. A sandbox adapter with enforced isolation and cancellation is required.")

    async def cancel(self):
        return True

    async def close(self):
        return None


def sandbox_factory(settings):
    config = getattr(settings, "executor", None)
    if config is None:
        return UnconfiguredSandbox
    from .oci_executor import OCIComputerFactory
    return OCIComputerFactory(config)
