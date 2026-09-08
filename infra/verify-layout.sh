#!/usr/bin/env bash
set -euo pipefail

infra_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root_dir=$infra_dir
storage_owner=${NEWSCRAFT_STORAGE_OWNER:-1000:1000}
require_env=0

usage() {
  cat >&2 <<'EOF'
Usage: verify-layout.sh [--root DIR] [--storage-owner UID:GID] [--require-env]

Checks mode-700 service directories, storage ownership, and mode-600 env files.
Use --require-env on a prepared host after creating both service .env files.
EOF
}

while (($#)); do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      root_dir=$2
      shift 2
      ;;
    --storage-owner)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      storage_owner=$2
      shift 2
      ;;
    --require-env)
      require_env=1
      shift
      ;;
    -h|--help)
      usage >&2
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

[[ "$storage_owner" =~ ^[0-9]+:[0-9]+$ ]] || {
  echo "--storage-owner must be numeric UID:GID (got $storage_owner)" >&2
  exit 2
}

stat_triplet() {
  local path=$1 result
  if result=$(stat -c '%a %u %g' "$path" 2>/dev/null); then
    printf '%s' "$result"
  else
    stat -f '%Lp %u %g' "$path"
  fi
}

check_dir() {
  local label=$1 path=$2 mode owner_uid owner_gid
  [[ -d "$path" ]] || { echo "$label is missing: $path" >&2; return 1; }
  read -r mode owner_uid owner_gid <<<"$(stat_triplet "$path")"
  [[ "$mode" == 700 ]] || { echo "$label must be mode 700 (got $mode): $path" >&2; return 1; }
  printf '%s: mode %s owner %s:%s\n' "$label" "$mode" "$owner_uid" "$owner_gid"
}

check_dir 'postgres data' "$root_dir/newscraft-postgres/data"
check_dir 'postgres backups' "$root_dir/newscraft-postgres/backups"
storage_data=$root_dir/newscraft-storage/data
check_dir 'storage data' "$storage_data"
read -r _ storage_uid storage_gid <<<"$(stat_triplet "$storage_data")"
expected_uid=${storage_owner%%:*}
expected_gid=${storage_owner##*:}
[[ "$storage_uid" == "$expected_uid" && "$storage_gid" == "$expected_gid" ]] || {
  echo "storage data must be owned by $storage_owner (got $storage_uid:$storage_gid): $storage_data" >&2
  exit 1
}

for env_file in "$root_dir/newscraft-postgres/.env" "$root_dir/newscraft-storage/.env"; do
  if [[ -e "$env_file" ]]; then
    [[ -f "$env_file" ]] || { echo "Env path is not a regular file: $env_file" >&2; exit 1; }
    read -r mode _ _ <<<"$(stat_triplet "$env_file")"
    [[ "$mode" == 600 ]] || { echo "Env file must be mode 600 (got $mode): $env_file" >&2; exit 1; }
    printf 'env file: %s (mode 600)\n' "$env_file"
  elif ((require_env)); then
    echo "Required env file is missing: $env_file" >&2
    exit 1
  fi
done

echo 'NewsCraft layout verification passed.'
