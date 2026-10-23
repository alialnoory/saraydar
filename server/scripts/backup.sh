#!/usr/bin/env bash
# SarayDar database backup. Attachments (documents, photos, signed agreements, profile photos) are stored inside
# the database, so this one file holds everything needed to restore the portal.
#   DATABASE_URL=postgres://...  ./scripts/backup.sh [output-folder]
# Use pg_dump of the same major version as the server (or newer). Optional: BACKUP_PASSPHRASE encrypts the file (gpg AES256).
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the database to back up}"
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
FILE="$OUT_DIR/saraydar-$STAMP.dump"
pg_dump --format=custom --compress=6 --no-owner --no-acl --file="$FILE" "$DATABASE_URL"
pg_restore --list "$FILE" > /dev/null                       # the archive must be readable
sha256sum "$FILE" | tee "$FILE.sha256"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" --symmetric --cipher-algo AES256 -o "$FILE.gpg" "$FILE"
  rm -f "$FILE"
  echo "Encrypted backup: $FILE.gpg"
else
  echo "Backup: $FILE"
fi
