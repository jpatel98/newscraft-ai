#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
bin_dir=${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@17/bin}
if [[ ! -x "$bin_dir/initdb" ]]; then
  bin_dir=$(dirname -- "$(command -v initdb)")
fi
for command_name in initdb pg_ctl pg_isready createdb psql pg_dump pg_restore; do
  [[ -x "$bin_dir/$command_name" ]] || { echo "PostgreSQL 17 tool is missing: $bin_dir/$command_name" >&2; exit 1; }
done
export PATH="$bin_dir:$PATH"

tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/newscraft-pg-restore.XXXXXX")
source_cluster=$tmp_root/source-cluster
destination_cluster=$tmp_root/destination-cluster
socket_base=$(mktemp -d /tmp/newscraft-pg-sockets.XXXXXX)
source_socket=$socket_base/source-socket
destination_socket=$socket_base/destination-socket
source_port=$((56000 + ($$ % 400)))
destination_port=$((source_port + 1))
backup_file=$tmp_root/newsroom-public.dump
mkdir -m 700 "$source_socket" "$destination_socket"

cleanup() {
  "$bin_dir/pg_ctl" -D "$source_cluster" -m fast stop >/dev/null 2>&1 || true
  "$bin_dir/pg_ctl" -D "$destination_cluster" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$tmp_root"
  rm -rf "$socket_base"
}
trap cleanup EXIT

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

start_cluster() {
  local cluster=$1 socket_dir=$2 port=$3 log=$4
  "$bin_dir/initdb" -D "$cluster" -U newscraft --no-locale --encoding=UTF8 \
    --auth-local=trust --auth-host=trust >"$tmp_root/${cluster##*/}-initdb.log"
  if ! "$bin_dir/pg_ctl" -D "$cluster" -o "-k $socket_dir -p $port -c shared_buffers=16MB -c max_connections=10 -c dynamic_shared_memory_type=mmap" \
    -l "$log" -w start >/dev/null; then
    cat "$log" >&2 || true
    return 1
  fi
  "$bin_dir/pg_isready" -h "$socket_dir" -p "$port" -d postgres >/dev/null
  "$bin_dir/createdb" -h "$socket_dir" -p "$port" -U newscraft newscraft
}

start_cluster "$source_cluster" "$source_socket" "$source_port" "$tmp_root/source-postgres.log"
start_cluster "$destination_cluster" "$destination_socket" "$destination_port" "$tmp_root/destination-postgres.log"

run_roles() {
  local socket_dir=$1 port=$2
  POSTGRES_USER=newscraft POSTGRES_DB=newscraft NEWSCRAFT_APP_PASSWORD=synthetic-app-password \
    PGHOST="$socket_dir" PGPORT="$port" "$repo_root/infra/newscraft-postgres/init/01-roles.sh" >/dev/null
}
run_roles "$source_socket" "$source_port"
run_roles "$destination_socket" "$destination_port"

PGHOST="$source_socket" PGPORT="$source_port" psql -X -v ON_ERROR_STOP=1 -U newscraft -d newscraft <<'SQL'
CREATE TABLE public.restore_probe (id integer PRIMARY KEY, message text NOT NULL);
INSERT INTO public.restore_probe VALUES (1, 'source-one'), (2, 'source-two');
CREATE INDEX restore_probe_message_idx ON public.restore_probe (message);
SQL

SOURCE_DATABASE_URL="postgresql://newscraft@127.0.0.1:$source_port/newscraft" \
BACKUP_FILE="$backup_file" \
DEST_DATABASE_URL="postgresql://newscraft@127.0.0.1:$destination_port/newscraft" \
  "$repo_root/infra/newscraft-postgres/backup-and-restore.sh" >/dev/null

[[ "$(file_mode "$backup_file")" == 600 ]] || {
  echo 'backup file is not mode 600' >&2
  exit 1
}

source_rows=$(PGHOST="$source_socket" PGPORT="$source_port" psql -X -Atq -U newscraft -d newscraft -c \
  "SELECT string_agg(id || ':' || message, ',' ORDER BY id) FROM public.restore_probe")
destination_rows=$(PGHOST="$destination_socket" PGPORT="$destination_port" psql -X -Atq -U newscraft -d newscraft -c \
  "SELECT string_agg(id || ':' || message, ',' ORDER BY id) FROM public.restore_probe")
[[ "$source_rows" == "$destination_rows" && "$destination_rows" == '1:source-one,2:source-two' ]] || {
  echo "restored rows differ (source=$source_rows destination=$destination_rows)" >&2
  exit 1
}

source_columns=$(PGHOST="$source_socket" PGPORT="$source_port" psql -X -Atq -U newscraft -d newscraft -c \
  "SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='restore_probe'")
destination_columns=$(PGHOST="$destination_socket" PGPORT="$destination_port" psql -X -Atq -U newscraft -d newscraft -c \
  "SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='restore_probe'")
[[ "$source_columns" == "$destination_columns" ]] || {
  echo "restored schema differs (source=$source_columns destination=$destination_columns)" >&2
  exit 1
}

# Exercise additive file reconciliation, including a reverse rollback write.
file_source=$tmp_root/file-source
file_destination=$tmp_root/file-destination
mkdir -p "$file_source/documents" "$file_destination"
printf 'source-file\n' > "$file_source/documents/brief.txt"
node "$repo_root/infra/sync-storage-files.mjs" --source "$file_source" --destination "$file_destination" \
  --apply --ack NEWSCRAFT_FINAL_SYNC_ACK >/dev/null
printf 'rollback-write\n' > "$file_destination/documents/rollback.txt"
node "$repo_root/infra/sync-storage-files.mjs" --source "$file_source" --destination "$file_destination" \
  --direction destination-to-source --apply --ack NEWSCRAFT_FINAL_SYNC_ACK >/dev/null
[[ "$(<"$file_source/documents/rollback.txt")" == 'rollback-write' ]] || {
  echo 'reverse storage reconciliation failed' >&2
  exit 1
}

echo 'PostgreSQL backup/restore and storage reconciliation fixture passed.'
