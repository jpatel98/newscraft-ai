#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

"$script_dir/layout-fixture.test.sh"
"$script_dir/newscraft-postgres/test-bootstrap.sh"
"$script_dir/newscraft-postgres/test-backup-restore.sh"
node "$script_dir/sync-storage-files.test.mjs"
node "$script_dir/newscraft-storage/cors.test.mjs"

echo 'All local migration fixtures passed.'
