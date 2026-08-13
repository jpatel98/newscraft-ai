#!/bin/sh

set -eu

EXPECTED_HERMES_COMMIT="5370d535ab926da41abe3ba4d9d975f1f94875d5"

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 /absolute/path/to/hermes-agent /absolute/path/to/venv /absolute/path/to/hermes-home" >&2
  exit 2
fi

HERMES_SOURCE_DIR=$1
RUNTIME_VENV=$2
HERMES_RUNTIME_HOME=$3
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVICE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SERVICE_DIR/../.." && pwd)

case "$HERMES_SOURCE_DIR" in
  /*) ;;
  *)
    echo "Hermes source path must be absolute." >&2
    exit 2
    ;;
esac

case "$RUNTIME_VENV" in
  /*) ;;
  *)
    echo "Runtime venv path must be absolute." >&2
    exit 2
    ;;
esac

case "$HERMES_RUNTIME_HOME" in
  /*) ;;
  *)
    echo "Hermes home path must be absolute." >&2
    exit 2
    ;;
esac

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to install the standard Hermes browser." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1 && ! command -v corepack >/dev/null 2>&1; then
  echo "pnpm or corepack is required for the standard Hermes browser." >&2
  exit 1
fi

pnpm_run() {
  (
    CDPATH= cd -- "$REPO_ROOT"
    if command -v pnpm >/dev/null 2>&1; then
      pnpm "$@"
    else
      corepack pnpm "$@"
    fi
  )
}

if ! git -C "$HERMES_SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Hermes source path is not a Git checkout." >&2
  exit 1
fi

ACTUAL_HERMES_COMMIT=$(git -C "$HERMES_SOURCE_DIR" rev-parse HEAD)
if [ "$ACTUAL_HERMES_COMMIT" != "$EXPECTED_HERMES_COMMIT" ]; then
  echo "Hermes checkout is not at the reviewed commit." >&2
  echo "Expected: $EXPECTED_HERMES_COMMIT" >&2
  echo "Actual:   $ACTUAL_HERMES_COMMIT" >&2
  exit 1
fi

if [ -n "$(git -C "$HERMES_SOURCE_DIR" status --porcelain --untracked-files=all)" ]; then
  echo "Hermes checkout has local changes. Use a clean reviewed checkout." >&2
  exit 1
fi

if [ -e "$RUNTIME_VENV" ]; then
  if [ ! -x "$RUNTIME_VENV/bin/python" ]; then
    echo "Runtime path exists but is not a valid virtual environment." >&2
    exit 1
  fi
else
  uv venv --python 3.11 "$RUNTIME_VENV"
fi
uv pip install --python "$RUNTIME_VENV/bin/python" --editable "$HERMES_SOURCE_DIR[agui]"
uv pip install --python "$RUNTIME_VENV/bin/python" "$SERVICE_DIR"

mkdir -p "$HERMES_RUNTIME_HOME/node/bin"
mkdir -p "$HERMES_RUNTIME_HOME/home"
chmod 700 "$HERMES_RUNTIME_HOME" "$HERMES_RUNTIME_HOME/home"
PATH="$HERMES_RUNTIME_HOME/node/bin:$PATH" \
  pnpm_run add --global \
    --global-dir "$HERMES_RUNTIME_HOME/node" \
    --global-bin-dir "$HERMES_RUNTIME_HOME/node/bin" \
    --save-exact --ignore-scripts agent-browser@0.26.0

AGENT_BROWSER_PACKAGE="$HERMES_RUNTIME_HOME/node/lib/node_modules/agent-browser"
if [ ! -d "$AGENT_BROWSER_PACKAGE" ]; then
  AGENT_BROWSER_LINK=$(find "$HERMES_RUNTIME_HOME/node" -type l \
    -path '*/node_modules/agent-browser' -print 2>/dev/null | head -n 1)
  if [ -n "$AGENT_BROWSER_LINK" ]; then
    AGENT_BROWSER_PACKAGE=$(CDPATH= cd -- "$AGENT_BROWSER_LINK" && pwd -P)
  fi
fi
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) AGENT_BROWSER_NATIVE="$AGENT_BROWSER_PACKAGE/bin/agent-browser-darwin-arm64" ;;
  Darwin:x86_64) AGENT_BROWSER_NATIVE="$AGENT_BROWSER_PACKAGE/bin/agent-browser-darwin-x64" ;;
  Linux:aarch64|Linux:arm64) AGENT_BROWSER_NATIVE="$AGENT_BROWSER_PACKAGE/bin/agent-browser-linux-arm64" ;;
  Linux:x86_64|Linux:amd64) AGENT_BROWSER_NATIVE="$AGENT_BROWSER_PACKAGE/bin/agent-browser-linux-x64" ;;
  *)
    echo "agent-browser does not include a reviewed binary for this platform." >&2
    exit 1
    ;;
esac
if [ ! -f "$AGENT_BROWSER_NATIVE" ]; then
  echo "The pinned agent-browser native binary is missing." >&2
  exit 1
fi
chmod 755 "$AGENT_BROWSER_NATIVE"
ln -sf "$AGENT_BROWSER_NATIVE" "$HERMES_RUNTIME_HOME/node/bin/agent-browser"

HOME="$HERMES_RUNTIME_HOME/home" \
  "$HERMES_RUNTIME_HOME/node/bin/agent-browser" install

HERMES_HOME="$HERMES_RUNTIME_HOME" \
HOME="$HERMES_RUNTIME_HOME/home" \
PATH="$HERMES_RUNTIME_HOME/node/bin:$PATH" \
  "$RUNTIME_VENV/bin/python" -c \
  "import agui_adapter.server; import hermes_chat.service; print('NewsCraft Hermes runtime and browser installed')"
