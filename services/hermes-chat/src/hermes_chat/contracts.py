from __future__ import annotations

from typing import Final

HERMES_RUN_START_PATH: Final = "/v1/runs/start"
HERMES_RUN_CANCEL_PATH: Final = "/v1/runs/{run_id}/cancel"
NEWSCRAFT_RUN_CLAIM_PATH: Final = "/claim"
NEWSCRAFT_RUN_FAIL_PATH: Final = "/fail"
NEWSCRAFT_RUN_RENEW_PATH: Final = "/renew"
NEWSCRAFT_RUN_RECOVER_PATH: Final = "/recover"
NEWSCRAFT_RUN_RELEASE_PATH: Final = "/release"
NEWSCRAFT_RUN_CALLBACK_PATH: Final = "/callback"
RUN_TOKEN_HEADER: Final = "x-newscraft-hermes-token"
RUN_LEASE_RENEW_INTERVAL_SECONDS: Final = 60.0

HERMES_TOOLSET: Final = "hermes-acp"
CRON_TOOLSET: Final = "cronjob_tools"
