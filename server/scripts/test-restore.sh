#!/usr/bin/env bash
# Rehearse a restore: back up SOURCE, restore into an EMPTY scratch database, and prove both are identical
# (row counts, migrations, last audit event, attachment checksums). Never point SCRATCH at production.
#   SOURCE_URL=postgres://... SCRATCH_URL=postgres://.../empty_db ./scripts/test-restore.sh
set -euo pipefail
: "${SOURCE_URL:?}"; : "${SCRATCH_URL:?}"
DIR="$(mktemp -d)"; trap 'rm -rf "$DIR"' EXIT
HERE="$(cd "$(dirname "$0")" && pwd)"
DATABASE_URL="$SOURCE_URL" BACKUP_PASSPHRASE= "$HERE/backup.sh" "$DIR" > /dev/null
"$HERE/restore.sh" "$(ls "$DIR"/*.dump)" "$SCRATCH_URL" > /dev/null
node "$HERE/verify.js" "$SOURCE_URL" > "$DIR/source.json"
node "$HERE/verify.js" "$SCRATCH_URL" > "$DIR/restored.json"
diff "$DIR/source.json" "$DIR/restored.json" > /dev/null && echo "RESTORE TEST PASSED: restored database matches the source." && grep -A3 '"attachments"' "$DIR/restored.json"
