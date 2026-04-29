#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPO_ROOT"

run_step() {
	local name=$1
	shift

	echo "==> $name"
	if "$@"; then
		echo "OK: $name"
	else
		local status=$?
		echo "ERROR: $name failed with exit code $status." >&2
		exit "$status"
	fi
}

if ! command -v pnpm >/dev/null 2>&1; then
	echo "ERROR: pnpm is required for agent preflight but was not found in PATH." >&2
	exit 127
fi

run_step "pnpm check" pnpm check
run_step "pnpm test" pnpm test
run_step "pnpm build" pnpm build

echo "Preflight checks passed."
