#!/bin/sh
set -eu

: "${RESTORE_TARGET_DATABASE_URL:?RESTORE_TARGET_DATABASE_URL is required}"
: "${RESTORE_FILE:?RESTORE_FILE is required}"

if [ "${RESTORE_CONFIRM:-}" != "RESTORE_OFD_V2_TO_EMPTY_DATABASE" ]; then
  printf '%s\n' 'Refusing restore. Set RESTORE_CONFIRM=RESTORE_OFD_V2_TO_EMPTY_DATABASE.' >&2
  exit 2
fi

if [ ! -f "${RESTORE_FILE}" ] || [ ! -f "${RESTORE_FILE}.sha256" ]; then
  printf '%s\n' 'Restore file or its .sha256 sidecar is missing.' >&2
  exit 2
fi

sha256sum --check "${RESTORE_FILE}.sha256"
table_count="$(psql "${RESTORE_TARGET_DATABASE_URL}" --no-align --tuples-only --command="select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog','information_schema');")"
if [ "${table_count}" -ne 0 ]; then
  printf '%s\n' 'Refusing restore: target database is not empty.' >&2
  exit 2
fi

pg_restore \
  --dbname="${RESTORE_TARGET_DATABASE_URL}" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  "${RESTORE_FILE}"

printf '%s\n' 'Restore completed. Run integrity checks before opening traffic.'
