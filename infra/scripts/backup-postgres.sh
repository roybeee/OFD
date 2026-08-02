#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:=/var/backups/ofd-v2}"

umask 077
mkdir -p "${BACKUP_DIR}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="${BACKUP_DIR}/ofd-v2-${timestamp}.dump"

pg_dump \
  --dbname="${DATABASE_URL}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="${backup_path}"

sha256sum "${backup_path}" > "${backup_path}.sha256"
printf '%s\n' "Backup created: ${backup_path}"
