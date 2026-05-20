#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${HARNESS_SERVICE_NAME:-newsroom-harness.service}"
HEALTH_URL="${HARNESS_HEALTH_URL:-http://127.0.0.1:8650/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-1}"
DRY_RUN="${RELOAD_HARNESS_DRY_RUN:-0}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPO_ROOT"

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

"$SCRIPT_DIR/preflight-harness.sh"

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

if ! command -v node >/dev/null 2>&1; then
	fail "node is required for the JSON health check but was not found in PATH."
fi

echo "Restarting $SERVICE_NAME..."
if ! sudo systemctl restart "$SERVICE_NAME"; then
	fail "failed to restart $SERVICE_NAME."
fi

echo "Waiting for $SERVICE_NAME health on $HEALTH_URL..."
if node "$SCRIPT_DIR/check-health.mjs" \
	--url "$HEALTH_URL" \
	--expect harness \
	--retries "$HEALTH_RETRIES" \
	--delay-ms "$((HEALTH_DELAY_SECONDS * 1000))"; then
	exit 0
fi

systemctl status "$SERVICE_NAME" --no-pager || true
exit 1
