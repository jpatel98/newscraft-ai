#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/newscraft-layout.XXXXXX")
trap 'rm -rf "$tmp_root"' EXIT

uid=$(id -u)
gid=$(id -g)
mkdir -p "$tmp_root/newscraft-postgres" "$tmp_root/newscraft-storage"
printf 'POSTGRES_PASSWORD=synthetic\n' > "$tmp_root/newscraft-postgres/.env"
printf 'NEWSCRAFT_STORAGE_API_KEY=synthetic\n' > "$tmp_root/newscraft-storage/.env"
chmod 644 "$tmp_root/newscraft-postgres/.env" "$tmp_root/newscraft-storage/.env"

"$script_dir/prepare-layout.sh" --root "$tmp_root" --storage-owner "$uid:$gid" --postgres-owner "$uid:$gid" >/dev/null
"$script_dir/verify-layout.sh" --root "$tmp_root" --storage-owner "$uid:$gid" --require-env >/dev/null

get_mode() {
  if stat -c '%a' "$1" 2>/dev/null; then
    return 0
  fi
  stat -f '%Lp' "$1"
}

[[ "$(get_mode "$tmp_root/newscraft-postgres/data")" == 700 ]]
[[ "$(get_mode "$tmp_root/newscraft-storage/data")" == 700 ]]
[[ "$(get_mode "$tmp_root/newscraft-storage/.env")" == 600 ]]
printf 'layout fixture passed\n'
