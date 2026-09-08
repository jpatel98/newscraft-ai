#!/usr/bin/env bash
set -euo pipefail

# Prepare the bind-mounted directories used by the isolated NewsCraft
# services. This never copies env files or removes existing data.
infra_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root_dir=$infra_dir
storage_owner=${NEWSCRAFT_STORAGE_OWNER:-1000:1000}
postgres_owner=${NEWSCRAFT_POSTGRES_OWNER:-}

usage() {
  cat >&2 <<'EOF'
Usage: prepare-layout.sh [--root DIR] [--storage-owner UID:GID]
                         [--postgres-owner UID:GID]

Creates mode-700 PostgreSQL data/backups and storage data directories. Existing
files are preserved. Storage is assigned to 1000:1000 by default.
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
    --postgres-owner)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      postgres_owner=$2
      shift 2
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
if [[ -n "$postgres_owner" && ! "$postgres_owner" =~ ^[0-9]+:[0-9]+$ ]]; then
  echo "--postgres-owner must be numeric UID:GID (got $postgres_owner)" >&2
  exit 2
fi

postgres_data=$root_dir/newscraft-postgres/data
postgres_backups=$root_dir/newscraft-postgres/backups
storage_data=$root_dir/newscraft-storage/data
install -d -m 700 "$postgres_data" "$postgres_backups" "$storage_data"
chmod 700 "$postgres_data" "$postgres_backups" "$storage_data"

# Do not follow symlinks while assigning the storage tree to the declared
# unprivileged container user.
chown "$storage_owner" "$storage_data"
while IFS= read -r -d '' path; do
  chown "$storage_owner" "$path"
done < <(find "$storage_data" -mindepth 1 -depth ! -type l -print0)

if [[ -n "$postgres_owner" ]]; then
  chown "$postgres_owner" "$postgres_data"
  while IFS= read -r -d '' path; do
    chown "$postgres_owner" "$path"
  done < <(find "$postgres_data" -mindepth 1 -depth ! -type l -print0)
fi

# Secrets are never generated or copied here. Tighten env files when present.
for env_file in "$root_dir/newscraft-postgres/.env" "$root_dir/newscraft-storage/.env"; do
  if [[ -e "$env_file" ]]; then
    [[ -f "$env_file" ]] || { echo "Env path is not a regular file: $env_file" >&2; exit 1; }
    chmod 600 "$env_file"
  fi
done

printf 'Prepared NewsCraft layout under %s\n' "$root_dir"
printf '  postgres data:    %s (mode 700)\n' "$postgres_data"
printf '  postgres backups: %s (mode 700)\n' "$postgres_backups"
printf '  storage data:     %s (mode 700, owner %s)\n' "$storage_data" "$storage_owner"
