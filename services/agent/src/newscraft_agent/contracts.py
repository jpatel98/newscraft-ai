from __future__ import annotations

from typing import Final

AGENT_RUN_START_PATH: Final = "/v1/runs/start"
AGENT_RUN_CANCEL_PATH: Final = "/v1/runs/{run_id}/cancel"
NEWSCRAFT_RUN_CLAIM_PATH: Final = "/claim"
NEWSCRAFT_RUN_FAIL_PATH: Final = "/fail"
NEWSCRAFT_RUN_RENEW_PATH: Final = "/renew"
NEWSCRAFT_RUN_RECOVER_PATH: Final = "/recover"
NEWSCRAFT_RUN_RELEASE_PATH: Final = "/release"
NEWSCRAFT_RUN_CALLBACK_PATH: Final = "/callback"
# The durable run API URL names a shared prefix. Keep artifact paths
# relative to that base, just like claim/callback/renew/recover/release.
NEWSCRAFT_ARTIFACT_GRANT_PATH: Final = "/{run_id}/artifact-grants"
NEWSCRAFT_ARTIFACT_REVISION_PATH: Final = "/{run_id}/artifacts/revisions"
NEWSCRAFT_ARTIFACT_FINALIZE_PATH: Final = "/{run_id}/artifacts/finalize"
RUN_TOKEN_HEADER: Final = "x-newscraft-agent-token"
RUN_LEASE_RENEW_INTERVAL_SECONDS: Final = 30.0
