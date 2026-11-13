# Migrating data from DRELQAVO to Synaptome

Synaptome was called DRELQAVO until version 0.2.0. Data written by the old version is not opened in place:
it is copied to a new home, verified, and the original is left exactly as it was.

## What changed

| | Before | Now |
|---|---|---|
| Command | `drelqavo` | `synaptome` (the old launcher still forwards, with a deprecation notice) |
| Environment variables | `DRELQAVO_*` | `SYNAPTOME_*` (old names are read as a fallback, with a notice on stderr) |
| Default home | `%LOCALAPPDATA%\drelqavo`, `~/.drelqavo` | `%LOCALAPPDATA%\synaptome`, `~/.synaptome` |
| Database | `drelqavo.db` | `synaptome.db` |
| Snapshot manifest | `.drelqavo-manifest.json` | `.synaptome-manifest.json` |
| Install marker in host directories | `.drelqavo.json` | `.synaptome.json` (the old marker is still recognised for verify and removal) |
| Project bridge record | `.drelqavo-bridge.json` | `.synaptome-bridge.json` (`bridge remove` handles both) |
| MCP server name | `drelqavo` | `synaptome` |

Synaptome refuses to open a directory that still holds un-migrated DRELQAVO data, so it can never write a
second database next to the old one.

## Commands

```bash
synaptome migrate --from <old home> --to <new home> --dry-run   # report only; writes nothing
synaptome migrate --from <old home> --to <new home>             # copy, verify, move into place
synaptome migrate --to <new home> --status                      # what changed since the migration
synaptome migrate --to <new home> --rollback                    # undo (see below)
synaptome migrate --to <new home> --export-delta                # write rows created since the migration to JSON
```

Defaults: `--from` is `$DRELQAVO_HOME` or the old default location; `--to` is `--home`, `$SYNAPTOME_HOME` or
the new default location.

## What the migration does

1. **Copies the database as one consistent snapshot without modifying the source.**
   - If the source is quiescent (no write-ahead log content, no rollback journal), the database file is the
     whole database: its bytes are copied and compared. No SQLite connection is opened on the source,
     because even a read-only connection to a WAL-mode database creates `-wal` and `-shm` files beside it.
   - If another process holds uncheckpointed writes, SQLite's online backup API is used through a read-only
     connection. It reads through the existing log. Nothing is checkpointed, vacuumed or rewritten.
2. Runs `integrity_check` and `foreign_key_check` on the copy and compares per-table row counts.
3. Copies every other file byte for byte and compares hashes. Legacy manifest and marker files are renamed
   in the copy.
4. Rewrites absolute paths stored in the database that pointed inside the old home so they point inside the
   new one. The append-only `events` table is not rewritten: history keeps what it recorded.
5. Re-hashes every snapshot file against its manifest.
6. Writes `.migration.json` (source location, source hashes, row counts) and moves the finished directory
   into place with a single rename.

Everything is built in a staging directory beside the destination. If the process dies, the destination
does not exist; the next run deletes the stale staging directory and starts again. A second run on a
migrated home is a no-op.

## Rollback

`--rollback` compares the migrated home with what was recorded at migration time.

- **Nothing changed:** the new home is removed. The original is intact and identical, so nothing is lost.
- **Data was created afterwards:** it refuses and changes nothing. You choose explicitly:
  - keep using the new home (do nothing);
  - `--export-delta` to write the new rows to `backups/post-migration-delta-<time>.json`;
  - `--rollback --discard-new-data --confirm <directory name>` to set the new home aside. It is **renamed**
    to `<home>.discarded-<time>`, not deleted.
- If the original home no longer exists, rollback refuses: it will not remove the only copy of the data.

## Verified

`packages/core/test/migrate.test.ts` (15 tests): fresh migration, idempotent rerun, dry run, a concurrent
connection with uncheckpointed WAL writes, interruption at three points with recovery, corrupted source,
tampered snapshot, bad source/destination, rollback with and without later data, missing original.

On real data (2026-11-12): the development home was migrated (12,621 rows in 24 tables, 1,258 files, 20
snapshots verified, 74 stored paths updated), rolled back, and migrated again. The source tree hashed
identically before and after, 1,260 files including the database and its log.
Evidence: `docs/evidence/phase-1/`.

## Limits

- Installations in **real** host directories are not touched by the migration. Their old marker file keeps
  working for verification and removal.
- The path rewrite is a case-sensitive text replacement of the old home path in text columns.
- A scheduled task registered under the old name is not renamed; none was ever registered by this project.
