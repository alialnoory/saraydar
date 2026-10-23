#!/usr/bin/env bash
# Restore a SarayDar backup into a database.
#   ./scripts/restore.sh <backup.dump|backup.dump.gpg> <target DATABASE_URL> [--replace]
# Refuses to touch a database that already has portal tables unless --replace is given.
# Restore into a NEW database first, check it with verify.js, then switch the app's DATABASE_URL.
set -euo pipefail
FILE="${1:?backup file}"; TARGET="${2:?target database URL}"; MODE="${3:-}"
if [[ "$FILE" == *.gpg ]]; then
  : "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE to decrypt}"
  PLAIN="$(mktemp --suffix=.dump)"; trap 'rm -f "$PLAIN"' EXIT
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" -o "$PLAIN" -d "$FILE"
  FILE="$PLAIN"
elif [ -f "$FILE.sha256" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256")
fi
EXISTING="$(psql "$TARGET" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [ "$EXISTING" != "0" ] && [ "$MODE" != "--replace" ]; then
  echo "The target database already has $EXISTING tables. Restore into an empty database, or add --replace." >&2
  exit 1
fi
pg_restore --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error --dbname="$TARGET" "$FILE"
echo "Restored. Now run: node scripts/verify.js \"$TARGET\""
