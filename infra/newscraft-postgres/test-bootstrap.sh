#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
bin_dir=${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@17/bin}
if [[ ! -x "$bin_dir/initdb" ]]; then
  bin_dir=$(dirname -- "$(command -v initdb)")
fi
for command_name in initdb pg_ctl pg_isready createdb psql; do
  [[ -x "$bin_dir/$command_name" ]] || { echo "PostgreSQL 17 tool is missing: $bin_dir/$command_name" >&2; exit 1; }
done

tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/newscraft-pg-bootstrap.XXXXXX")
cluster=$tmp_root/cluster
socket_base=$(mktemp -d /tmp/newscraft-pg-sockets.XXXXXX)
socket_dir=$socket_base/socket
port=$((55000 + ($$ % 1000)))
mkdir -m 700 "$socket_dir"

cleanup() {
  "$bin_dir/pg_ctl" -D "$cluster" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$tmp_root"
  rm -rf "$socket_base"
}
trap cleanup EXIT

"$bin_dir/initdb" -D "$cluster" -U newscraft --no-locale --encoding=UTF8 \
  --auth-local=trust --auth-host=trust >"$tmp_root/initdb.log"
"$bin_dir/pg_ctl" -D "$cluster" -o "-k $socket_dir -p $port -c shared_buffers=16MB -c max_connections=10 -c dynamic_shared_memory_type=mmap" \
  -l "$tmp_root/postgres.log" -w start >/dev/null
"$bin_dir/pg_isready" -h "$socket_dir" -p "$port" -d postgres >/dev/null
"$bin_dir/createdb" -h "$socket_dir" -p "$port" -U newscraft newscraft

export POSTGRES_USER=newscraft
export POSTGRES_DB=newscraft
export NEWSCRAFT_APP_PASSWORD=synthetic-app-password
export PGHOST=$socket_dir
export PGPORT=$port
"$repo_root/infra/newscraft-postgres/init/01-roles.sh" >/dev/null

role_state=$("$bin_dir/psql" -X -Atq -v ON_ERROR_STOP=1 -U newscraft -d newscraft \
  -c "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'newscraft_app'")
[[ "$role_state" == 't|f|t' ]] || { echo "unexpected newscraft_app role state: $role_state" >&2; exit 1; }

"$bin_dir/psql" -X -v ON_ERROR_STOP=1 -U newscraft -d newscraft <<'SQL'
CREATE TABLE public.bootstrap_probe (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO public.bootstrap_probe VALUES (1, 'admin-created');
SQL

app_result=$("$bin_dir/psql" -X -Atq -v ON_ERROR_STOP=1 -U newscraft_app -d newscraft <<'SQL'
INSERT INTO public.bootstrap_probe VALUES (2, 'app-inserted');
SELECT count(*) FROM public.bootstrap_probe;
SQL
)
[[ "$app_result" == '2' ]] || { echo "default grants did not permit app DML (got $app_result)" >&2; exit 1; }

echo 'PostgreSQL role/bootstrap fixture passed.'
