# Backups and restoration

Everything the portal stores lives in one PostgreSQL database. That includes:

- all records;
- the audit log;
- the outbox;
- uploaded documents and photos, signed agreements, letterheads and profile photos (`files.data`, `user_photos`).

So one database backup is a complete backup. There is no separate attachments folder to copy.

## What is in the repository

| File | Purpose |
|---|---|
| `server/scripts/backup.sh` | Creates a compressed `pg_dump` archive. It confirms the archive is readable and writes a SHA-256 checksum. If `BACKUP_PASSPHRASE` is set, it also encrypts the archive (GPG, AES-256). |
| `server/scripts/restore.sh` | Restores an archive into a database, decrypting it first if needed. It refuses to write over a database that already has tables unless you add `--replace`. |
| `server/scripts/verify.js` | Prints a fingerprint of a database: row counts for every table, applied migrations and the last audit event. It also recomputes the SHA-256 of every stored attachment and exits with code 1 if any attachment is damaged. |
| `server/scripts/test-restore.sh` | Rehearses the full cycle: backup → restore into an empty scratch database → compare the fingerprints. |
| `.github/workflows/backup.yml` | Nightly encrypted backup at 02:30 Bahrain time, kept for 30 days as a private GitHub artifact. It stays inactive until the two secrets below are added. |

You need `pg_dump` and `pg_restore` of the **same major version as the server, or newer**. The workflow installs version 18, matching the Render database (PostgreSQL 18).

## Schedule and retention (recommended)

- **Paid Render database:** Render keeps its own daily snapshots and point-in-time recovery. The retention period depends on the plan; see Render › database › Recovery. Keep the GitHub nightly backup as well, as an independent copy outside Render.
- **Free Render database (now):** Render keeps no backups, and the free database expires on 22 Nov 2026. Turn on the nightly workflow now, and move to a paid database before real use.
- **Retention:** GitHub keeps the nightly backups for 30 days. On the first day of each month, download one backup and keep it for 12 months on company storage. Keep the passphrase separately from the files.

### Turning on the nightly backup (owner, once)

1. In Render, open the database. Copy the **External Database URL**.
2. In GitHub, open the repository and go to Settings › Secrets and variables › Actions › New repository secret. Add:
   - `BACKUP_DATABASE_URL` = the URL you copied.
   - `BACKUP_PASSPHRASE` = a long passphrase. Write it down and keep it safe offline. Without it, no backup can be opened.
3. Go to Actions › Database backup › Run workflow. Check that the run finishes and has an artifact named `saraydar-backup-N`.

## Restoring

Restore into a **new, empty** database first. Check it, then point the app at it.

```bash
# 1. Create an empty database (Render: New › PostgreSQL), copy its External URL.
# 2. Restore (decrypts automatically when the file ends in .gpg)
BACKUP_PASSPHRASE='…' ./server/scripts/restore.sh saraydar-20261124-233000Z.dump.gpg "postgres://…new-db…"
# 3. Check it: row counts, migrations, attachment checksums (exit code 0 = all attachments intact)
node server/scripts/verify.js "postgres://…new-db…"
# 4. In Render › saraydar-api › Environment, set DATABASE_URL to the new database and redeploy.
# 5. Sign in, open a project with photos, open a document, and check the latest audit events.
```

To restore over the existing database, add `--replace`. Only do this after taking a fresh backup of it.

Sessions are restored too, so people stay signed in. To force everyone to sign in again, clear the sessions after the restore: `delete from sessions;`.

## Tested restoration procedure (actual run, 24 Oct 2026)

The test was run in the build environment with PostgreSQL 16:

1. The source database was filled by running the Phase 7 acceptance test against it. That gave four sections, investors, invitations, progress photos, listing photos and documents.
2. `test-restore.sh` backed up the source, restored it into an empty scratch database and compared the two fingerprints.

   Result: `RESTORE TEST PASSED: restored database matches the source.` All row counts and migrations were identical, and 6 attachments had 0 damaged.
3. A second restore into the now non-empty database was refused (exit code 1), as designed.
4. The portal was started on the restored database. Sign-in worked, and a restored attachment downloaded correctly (HTTP 200, `image/png`).

Repeat this rehearsal against a scratch database **every quarter**, and after any change to the hosting:

```bash
SOURCE_URL="postgres://…production…" SCRATCH_URL="postgres://…empty scratch db…" ./server/scripts/test-restore.sh
```
