#!/bin/sh
set -eu

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [/absolute/path/to/venv]" >&2
  exit 2
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVICE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RUNTIME_VENV=${1:-"$SERVICE_DIR/.venv"}
case "$RUNTIME_VENV" in
  /*) ;;
  *) echo "Agent virtual environment path must be absolute." >&2; exit 2 ;;
esac
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required." >&2
  exit 1
fi
# Install only NewsCraft's reviewed package and locked Python dependencies.
# No code-execution backend is provisioned by this installer.
# The HTTPS gateway's bounded transport is audited against CPython 3.11.
# Require an existing interpreter; runtime downloads need operator approval.
UV_PROJECT_ENVIRONMENT="$RUNTIME_VENV" uv sync --locked --no-dev --python cpython@3.11 --no-python-downloads --project "$SERVICE_DIR"
"$RUNTIME_VENV/bin/python" -c 'import hermes_chat.service; print("NewsCraft owned research worker installed")'
