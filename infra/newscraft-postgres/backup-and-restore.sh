#!/bin/bash
set -euo pipefail

# Deliberately refuses to overwrite an existing backup. Run this on a machine
# with a pg_dump client matching (or newer than) the source server major.
: "${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL in the environment}"
: "${BACKUP_FILE:?set BACKUP_FILE to a new mode-600 path}"
: "${DEST_DATABASE_URL:?set DEST_DATABASE_URL for the isolated NewsCraft DB}"

if [[ -e "$BACKUP_FILE" ]]; then
  echo "Refusing to overwrite existing backup: $BACKUP_FILE" >&2
  exit 2
fi

umask 077
pg_dump --dbname="$SOURCE_DATABASE_URL" --schema=public --format=custom \
  --no-owner --no-acl --file="$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

# Restore is intentionally additive: it never drops schemas, tables, or data.
# Use a fresh destination database for the first restore. A later cutover
# should use a reviewed maintenance window and an explicit backup first.
restore_list=$(mktemp)
trap 'rm -f "$restore_list"' EXIT
# pg_dump records the built-in public schema in a schema-scoped archive, but
# initdb has already created that schema in the destination database. Exclude
# only those two catalog entries so the restore remains additive and strict.
pg_restore --list "$BACKUP_FILE" |
	awk '$0 !~ / SCHEMA - public( |$)/ && $0 !~ / COMMENT - SCHEMA public( |$)/' > "$restore_list"
pg_restore --dbname="$DEST_DATABASE_URL" --no-owner --no-acl \
	--exit-on-error --use-list="$restore_list" "$BACKUP_FILE"

echo "Backup and restore completed: $BACKUP_FILE"
