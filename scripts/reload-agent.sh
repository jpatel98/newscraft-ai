#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-hermes-ui.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-1}"
DRY_RUN="${RELOAD_AGENT_DRY_RUN:-0}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPO_ROOT"

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

"$SCRIPT_DIR/preflight-agent.sh"

if [ "$DRY_RUN" = "1" ] || [ "$DRY_RUN" = "true" ]; then
	echo "Dry run requested; skipping restart and health check for $SERVICE_NAME."
	exit 0
fi

if ! command -v sudo >/dev/null 2>&1; then
	fail "sudo is required to restart $SERVICE_NAME but was not found in PATH."
fi

if ! command -v systemctl >/dev/null 2>&1; then
	fail "systemctl is required to restart $SERVICE_NAME but was not found in PATH."
fi

if ! command -v curl >/dev/null 2>&1; then
	fail "curl is required for the health check but was not found in PATH."
fi

echo "Restarting $SERVICE_NAME..."
if ! sudo systemctl restart "$SERVICE_NAME"; then
	fail "failed to restart $SERVICE_NAME."
fi

echo "Waiting for $SERVICE_NAME health on $HEALTH_URL..."
attempt=1
while [ "$attempt" -le "$HEALTH_RETRIES" ]; do
	if curl -fsS "$HEALTH_URL" >/dev/null; then
		echo "OK: $SERVICE_NAME is healthy."
		exit 0
	fi

	sleep "$HEALTH_DELAY_SECONDS"
	attempt=$((attempt + 1))
done

echo "ERROR: $SERVICE_NAME did not become healthy at $HEALTH_URL within $HEALTH_RETRIES attempts." >&2
systemctl status "$SERVICE_NAME" --no-pager || true
exit 1
