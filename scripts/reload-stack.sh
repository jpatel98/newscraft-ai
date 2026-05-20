#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

echo "Reloading newsroom harness first..."
"$SCRIPT_DIR/reload-harness.sh"

echo "Reloading SvelteKit UI..."
"$SCRIPT_DIR/reload-agent.sh"

echo "OK: NewsCraft stack reload completed."
