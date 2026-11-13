import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY, PRODUCT } from './identity';

/**
 * Home-directory migration (previous product name -> Synaptome).
 *
 * Guarantees:
 *  - The source home is never written, checkpointed, vacuumed, renamed or deleted, and no file is created in it.
 *  - The database is copied as one consistent snapshot: byte copy when the source is quiescent, SQLite's
 *    online backup API when another process holds uncheckpointed writes (see `copyDatabase`).
 *  - Everything is assembled in a staging directory next to the destination and moved into place with one
 *    rename, so an interrupted run never leaves a half-written destination.
 *  - A marker makes a repeated run a no-op.
 *  - Rollback never silently destroys data created after the migration.
 */

export const MIGRATION_MARKER = '.migration.json';
const STAGING_TAG = '.migrating-';
/** Append-only history keeps the paths it recorded at the time. */
const PATH_REWRITE_SKIP = new Set(['events', 'schema_migrations']);

export type MigrationErrorCode =
  | 'source-missing'
  | 'source-not-a-home'
  | 'destination-not-empty'
  | 'destination-inside-source'
  | 'integrity-failed'
  | 'row-count-mismatch'
  | 'file-mismatch'
  | 'snapshot-hash-mismatch'
  | 'not-migrated'
  | 'source-gone'
  | 'post-migration-data'
  | 'confirmation-required'
  | 'interrupted';

export class MigrationError extends Error {
  constructor(message: string, public code: MigrationErrorCode, public details?: unknown) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationMarker {
  product: string;
  migratedFrom: string;
  sourceProduct: string;
  at: string;
  sourceDbFile: string;
  sourceHashes: Record<string, string | null>;
  tables: Record<string, number>;
  maxRowid: Record<string, number>;
  treeDigest: string;
  files: number;
}

export interface MigrationReport {
  status: 'migrated' | 'already-migrated' | 'dry-run';
  from: string;
  to: string;
  at: string;
  tables: Record<string, number>;
  rows: number;
  files: number;
  snapshotsVerified: number;
  renamedFiles: number;
  rewrittenPathValues: number;
  integrity: string;
  source: {
    dbFile: string;
    hashesBefore: Record<string, string | null>;
    hashesAfter: Record<string, string | null>;
    /** Database and WAL bytes identical before and after (the -shm lock index is transient and excluded). */
    untouched: boolean;
    /** Another process committed to the source while it was being copied; the copy is still one consistent snapshot. */
    concurrentWrites: boolean;
  };
}

export interface MigrateOptions {
  from: string;
  to: string;
  dryRun?: boolean;
  /** Test seam: throws at the named point to simulate a crash. */
  interruptAt?: 'after-db-copy' | 'after-files' | 'before-rename';
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const fileHash = (p: string): string | null => (fs.existsSync(p) ? sha(fs.readFileSync(p)) : null);
const isDbFile = (name: string) => /\.db(-wal|-shm|-journal)?$/.test(name);

function sourceDbName(from: string): string | null {
  for (const n of [LEGACY.dbFile, PRODUCT.dbFile]) if (fs.existsSync(path.join(from, n))) return n;
  return null;
}

function dbFileHashes(home: string, dbName: string): Record<string, string | null> {
  return { db: fileHash(path.join(home, dbName)), wal: fileHash(path.join(home, `${dbName}-wal`)) };
}

function userTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string | null }[];
  return rows.map((r) => r.name);
}
function plainTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string | null }[];
  const virtual = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map((r) => r.name);
  return rows.filter((r) => !virtual.includes(r.name) && !virtual.some((v) => r.name.startsWith(`${v}_`))).map((r) => r.name);
}
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of userTables(db)) out[t] = Number((db.prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get() as { n: number }).n);
  return out;
}
function maxRowids(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of plainTables(db)) {
    try {
      out[t] = Number((db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${q(t)}`).get() as { m: number }).m);
    } catch {
      /* WITHOUT ROWID table: row counts still cover it */
    }
  }
  return out;
}

/** Relative paths (forward slashes) of every non-database file under a home. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (!rel.includes('/') && (isDbFile(e.name) || e.name === MIGRATION_MARKER)) continue;
        out.push(rel);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

/** Legacy file names are renamed in the copy; the content of everything except install markers is unchanged. */
function renamedRel(rel: string): string {
  const base = path.posix.basename(rel);
  const dir = path.posix.dirname(rel);
  const next = base === LEGACY.manifestFile ? PRODUCT.manifestFile : base === LEGACY.markerFile ? PRODUCT.markerFile : base;
  return dir === '.' ? next : `${dir}/${next}`;
}

/** Digest of the data directories that hold user-visible state; `backups` and `cache` are working space. */
function treeDigest(home: string): { digest: string; files: number } {
  const files = listFiles(home).filter((r) => !/^(backups|cache)\//.test(r));
  const h = createHash('sha256');
  for (const r of files) h.update(`${r}\0${fs.statSync(path.join(home, r)).size}\n`);
  return { digest: h.digest('hex'), files: files.length };
}

function pathVariants(p: string): string[] {
  const native = path.resolve(p);
  return [...new Set([native.replace(/\\/g, '\\\\'), native, native.replace(/\\/g, '/')])];
}

function rewritePaths(db: DatabaseSync, from: string, to: string): number {
  const a = pathVariants(from);
  const b = pathVariants(to);
  let changed = 0;
  for (const t of plainTables(db)) {
    if (PATH_REWRITE_SKIP.has(t)) continue;
    const cols = (db.prepare(`PRAGMA table_info(${q(t)})`).all() as { name: string; type: string }[]).filter((c) => /TEXT|CHAR|CLOB|^$/i.test(c.type ?? ''));
    for (const c of cols) {
      for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        const r = db.prepare(`UPDATE ${q(t)} SET ${q(c.name)} = REPLACE(${q(c.name)}, ?, ?) WHERE typeof(${q(c.name)}) = 'text' AND instr(${q(c.name)}, ?) > 0`).run(a[i], b[i], a[i]);
        changed += Number(r.changes);
      }
    }
  }
  return changed;
}

function verifySnapshots(home: string): number {
  const store = path.join(home, 'store');
  let n = 0;
  for (const rel of listFiles(store)) {
    if (path.posix.basename(rel) !== PRODUCT.manifestFile) continue;
    const dir = path.join(store, path.posix.dirname(rel));
    const manifest = JSON.parse(fs.readFileSync(path.join(store, rel), 'utf8')) as { files?: { path: string; sha256: string }[] };
    for (const f of manifest.files ?? []) {
      const actual = fileHash(path.join(dir, f.path));
      if (actual !== f.sha256) throw new MigrationError(`Snapshot file ${path.join(dir, f.path)} does not match its manifest`, 'snapshot-hash-mismatch', { expected: f.sha256, actual });
    }
    n++;
  }
  return n;
}

function cleanStaleStaging(to: string) {
  const parent = path.dirname(to);
  if (!fs.existsSync(parent)) return;
  for (const e of fs.readdirSync(parent)) if (e.startsWith(`${path.basename(to)}${STAGING_TAG}`)) fs.rmSync(path.join(parent, e), { recursive: true, force: true });
}

function renameWithRetry(a: string, b: string) {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(a, b);
      return;
    } catch (e) {
      last = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (i + 1));
    }
  }
  throw last;
}

export function readMigrationMarker(home: string): MigrationMarker | null {
  const p = path.join(home, MIGRATION_MARKER);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as MigrationMarker;
  } catch {
    return null;
  }
}

export async function migrateHome(opts: MigrateOptions): Promise<MigrationReport> {
  const from = path.resolve(opts.from);
  const to = path.resolve(opts.to);
  const at = new Date().toISOString();

  const existing = readMigrationMarker(to);
  if (existing && path.resolve(existing.migratedFrom) === from) {
    return { status: 'already-migrated', from, to, at: existing.at, tables: existing.tables, rows: Object.values(existing.tables).reduce((s, n) => s + n, 0), files: existing.files, snapshotsVerified: 0, renamedFiles: 0, rewrittenPathValues: 0, integrity: 'ok', source: { dbFile: existing.sourceDbFile, hashesBefore: existing.sourceHashes, hashesAfter: existing.sourceHashes, untouched: true, concurrentWrites: false } };
  }
  if (!fs.existsSync(from)) throw new MigrationError(`Source ${from} does not exist`, 'source-missing');
  const dbName = sourceDbName(from);
  if (!dbName) throw new MigrationError(`${from} does not contain a ${LEGACY.dbFile} or ${PRODUCT.dbFile} database`, 'source-not-a-home');
  if (to === from || to.startsWith(from + path.sep)) throw new MigrationError('The destination must be outside the source directory', 'destination-inside-source');
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new MigrationError(`Destination ${to} already exists and is not empty`, 'destination-not-empty');

  const hashesBefore = dbFileHashes(from, dbName);
  const sourceFiles = listFiles(from);
  let staging = '';
  try {
    if (opts.dryRun) {
      // Inspect a throw-away copy in the system temp directory; nothing is created near the source or destination.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${PRODUCT.bin}-dryrun-`));
      try {
        const tmpDb = path.join(tmp, PRODUCT.dbFile);
        await copyDatabase(from, dbName, tmpDb);
        const probe = new DatabaseSync(tmpDb);
        try {
          const integrity = (probe.prepare('PRAGMA integrity_check').get() as Record<string, string>)['integrity_check'];
          const tables = tableCounts(probe);
          return { status: 'dry-run', from, to, at, tables, rows: Object.values(tables).reduce((s, n) => s + n, 0), files: sourceFiles.length, snapshotsVerified: 0, renamedFiles: sourceFiles.filter((r) => renamedRel(r) !== r).length, rewrittenPathValues: 0, integrity, source: { dbFile: dbName, hashesBefore, hashesAfter: dbFileHashes(from, dbName), untouched: true, concurrentWrites: false } };
        } finally {
          probe.close();
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    cleanStaleStaging(to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    staging = `${to}${STAGING_TAG}${process.pid}-${Date.now()}`;
    fs.mkdirSync(staging, { recursive: true });

    // 1. Consistent database copy (see copyDatabase for how the source is left untouched).
    const destDb = path.join(staging, PRODUCT.dbFile);
    const { countsBefore, countsAfter } = await copyDatabase(from, dbName, destDb);
    if (opts.interruptAt === 'after-db-copy') throw new MigrationError('interrupted (test)', 'interrupted');

    // 2. Verify the copy.
    const copy = new DatabaseSync(destDb);
    let integrity = '';
    let rewritten = 0;
    let copyCounts: Record<string, number> = {};
    let rowids: Record<string, number> = {};
    try {
      integrity = (copy.prepare('PRAGMA integrity_check').get() as Record<string, string>)['integrity_check'];
      if (integrity !== 'ok') throw new MigrationError(`Copied database failed its integrity check: ${integrity}`, 'integrity-failed');
      const fk = copy.prepare('PRAGMA foreign_key_check').all();
      if (fk.length) throw new MigrationError(`Copied database has ${fk.length} foreign-key violation(s)`, 'integrity-failed', fk.slice(0, 20));
      copyCounts = tableCounts(copy);
      // A byte-identical file copy needs no count comparison; an online backup is checked against the source.
      for (const t of Object.keys(countsBefore ?? {})) {
        const lo = Math.min(countsBefore![t], countsAfter?.[t] ?? countsBefore![t]);
        const hi = Math.max(countsBefore![t], countsAfter?.[t] ?? countsBefore![t]);
        if (copyCounts[t] === undefined || copyCounts[t] < lo || copyCounts[t] > hi) throw new MigrationError(`Row count mismatch in ${t}: source ${lo}${hi !== lo ? `–${hi}` : ''}, copy ${copyCounts[t]}`, 'row-count-mismatch');
      }
      // 3. Absolute paths that pointed inside the old home now point inside the new one.
      rewritten = rewritePaths(copy, from, to);
      rowids = maxRowids(copy);
      copy.exec('PRAGMA journal_mode = DELETE');
    } finally {
      copy.close();
    }

    // 4. Files: copied byte for byte; legacy manifest and marker file names are renamed.
    let renamed = 0;
    for (const rel of sourceFiles) {
      const dst = path.join(staging, renamedRel(rel));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (path.posix.basename(rel) === LEGACY.markerFile || path.posix.basename(rel) === PRODUCT.markerFile) {
        let text = fs.readFileSync(path.join(from, rel), 'utf8');
        try {
          const m = JSON.parse(text);
          if (m && m.managedBy === LEGACY.managedBy) m.managedBy = PRODUCT.managedBy;
          text = JSON.stringify(m, null, 2);
        } catch {
          /* not JSON: copy as is */
        }
        fs.writeFileSync(dst, text);
      } else {
        fs.copyFileSync(path.join(from, rel), dst);
        if (fileHash(dst) !== fileHash(path.join(from, rel))) throw new MigrationError(`Copied file differs from its source: ${rel}`, 'file-mismatch');
      }
      if (renamedRel(rel) !== rel) renamed++;
    }
    const copiedFiles = listFiles(staging);
    if (copiedFiles.length !== sourceFiles.length) throw new MigrationError(`File count mismatch: source ${sourceFiles.length}, copy ${copiedFiles.length}`, 'file-mismatch');
    for (const d of ['store', 'quarantine', 'sandbox-hosts', 'forge', 'backups', 'cache']) fs.mkdirSync(path.join(staging, d), { recursive: true });
    if (opts.interruptAt === 'after-files') throw new MigrationError('interrupted (test)', 'interrupted');

    // 5. Every snapshot still matches its manifest.
    const snapshotsVerified = verifySnapshots(staging);

    // 6. The source was not modified by this run.
    const hashesAfter = dbFileHashes(from, dbName);
    const concurrentWrites = JSON.stringify(countsBefore ?? null) !== JSON.stringify(countsAfter ?? null) || hashesBefore.wal !== hashesAfter.wal || hashesBefore.db !== hashesAfter.db;
    if (listFiles(from).length !== sourceFiles.length && !concurrentWrites) throw new MigrationError('The source directory changed during the migration', 'file-mismatch');

    const tree = treeDigest(staging);
    const marker: MigrationMarker = { product: PRODUCT.name, migratedFrom: from, sourceProduct: dbName === LEGACY.dbFile ? LEGACY.name : PRODUCT.name, at, sourceDbFile: dbName, sourceHashes: hashesAfter, tables: copyCounts, maxRowid: rowids, treeDigest: tree.digest, files: tree.files };
    fs.writeFileSync(path.join(staging, MIGRATION_MARKER), JSON.stringify(marker, null, 2));
    if (opts.interruptAt === 'before-rename') throw new MigrationError('interrupted (test)', 'interrupted');

    // 7. One rename puts the finished home in place.
    if (fs.existsSync(to)) fs.rmdirSync(to);
    renameWithRetry(staging, to);
    staging = '';

    return { status: 'migrated', from, to, at, tables: copyCounts, rows: Object.values(copyCounts).reduce((s, n) => s + n, 0), files: sourceFiles.length, snapshotsVerified, renamedFiles: renamed, rewrittenPathValues: rewritten, integrity, source: { dbFile: dbName, hashesBefore, hashesAfter, untouched: !concurrentWrites, concurrentWrites } };
  } catch (e) {
    if (staging && !(e instanceof MigrationError && e.code === 'interrupted')) fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

const walHasContent = (home: string, dbName: string) => {
  const p = path.join(home, `${dbName}-wal`);
  return fs.existsSync(p) && fs.statSync(p).size > 0;
};
const journalPresent = (home: string, dbName: string) => fs.existsSync(path.join(home, `${dbName}-journal`));

/**
 * Copies the source database to `dest` as one consistent snapshot without modifying the source.
 *
 * Quiescent source (no write-ahead log content, no rollback journal): the database file is the whole
 * database, so its bytes are copied and compared. No SQLite connection is opened on the source at all, which
 * matters because even a read-only connection to a WAL-mode database creates `-wal` and `-shm` sidecar files
 * next to it. If the file changes or a log appears while copying, the attempt is discarded.
 *
 * Live source (another process has uncheckpointed writes): SQLite's online backup API through a read-only
 * connection. It reads the database through the existing log without checkpointing or rewriting anything;
 * the sidecar files already exist, so none are created.
 */
async function copyDatabase(from: string, dbName: string, dest: string): Promise<{ mode: 'file-copy' | 'online-backup'; countsBefore?: Record<string, number>; countsAfter?: Record<string, number> }> {
  const srcPath = path.join(from, dbName);
  for (let attempt = 0; attempt < 3 && !walHasContent(from, dbName) && !journalPresent(from, dbName); attempt++) {
    const before = fileHash(srcPath);
    fs.copyFileSync(srcPath, dest);
    if (!walHasContent(from, dbName) && !journalPresent(from, dbName) && fileHash(srcPath) === before && fileHash(dest) === before) return { mode: 'file-copy' };
    fs.rmSync(dest, { force: true });
  }
  const src = new DatabaseSync(srcPath, { readOnly: true });
  try {
    const check = (src.prepare('PRAGMA quick_check').get() as Record<string, string>)['quick_check'];
    if (check !== 'ok') throw new MigrationError(`Source database failed its integrity check: ${check}`, 'integrity-failed');
    const countsBefore = tableCounts(src);
    await backup(src, dest);
    return { mode: 'online-backup', countsBefore, countsAfter: tableCounts(src) };
  } finally {
    src.close();
  }
}

export interface PostMigrationDelta {
  changed: boolean;
  tables: Record<string, { atMigration: number; now: number }>;
  filesAtMigration: number;
  filesNow: number;
  treeChanged: boolean;
}

/** What has been created or changed in a migrated home since the migration. */
export function postMigrationDelta(to: string): PostMigrationDelta {
  const marker = readMigrationMarker(to);
  if (!marker) throw new MigrationError(`${to} was not created by a migration`, 'not-migrated');
  const db = new DatabaseSync(path.join(to, PRODUCT.dbFile), { readOnly: true });
  try {
    const now = tableCounts(db);
    const tables: PostMigrationDelta['tables'] = {};
    for (const t of new Set([...Object.keys(now), ...Object.keys(marker.tables)])) if ((now[t] ?? 0) !== (marker.tables[t] ?? 0)) tables[t] = { atMigration: marker.tables[t] ?? 0, now: now[t] ?? 0 };
    const tree = treeDigest(to);
    const treeChanged = tree.digest !== marker.treeDigest;
    return { changed: Object.keys(tables).length > 0 || treeChanged, tables, filesAtMigration: marker.files, filesNow: tree.files, treeChanged };
  } finally {
    db.close();
  }
}

/** Writes the rows added since the migration to a JSON file inside the migrated home's backups directory. */
export function exportPostMigrationDelta(to: string): { file: string; rows: number } {
  const marker = readMigrationMarker(to);
  if (!marker) throw new MigrationError(`${to} was not created by a migration`, 'not-migrated');
  const db = new DatabaseSync(path.join(to, PRODUCT.dbFile), { readOnly: true });
  try {
    const out: Record<string, unknown[]> = {};
    let rows = 0;
    for (const t of plainTables(db)) {
      const since = marker.maxRowid[t];
      if (since === undefined) continue;
      const added = db.prepare(`SELECT rowid AS _rowid, * FROM ${q(t)} WHERE rowid > ? ORDER BY rowid`).all(since);
      if (added.length) {
        out[t] = added;
        rows += added.length;
      }
    }
    const dir = path.join(to, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `post-migration-delta-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), migratedAt: marker.at, tables: out }, null, 2));
    return { file, rows };
  } finally {
    db.close();
  }
}

export interface RollbackResult {
  status: 'rolled-back' | 'discarded-preserved';
  to: string;
  source: string;
  /** Where the discarded home was kept. Nothing is deleted when post-migration data exists. */
  preservedAt?: string;
}

/**
 * Undoes a migration. If nothing changed since the migration the new home is removed (the source is intact and
 * identical). If anything changed, it refuses unless the caller explicitly chooses to discard, and even then
 * the home is renamed aside, not deleted.
 */
export function rollbackMigration(to: string, opts: { discardNewData?: boolean; confirm?: string } = {}): RollbackResult {
  const home = path.resolve(to);
  const marker = readMigrationMarker(home);
  if (!marker) throw new MigrationError(`${home} was not created by a migration; nothing to roll back`, 'not-migrated');
  const source = marker.migratedFrom;
  if (!fs.existsSync(path.join(source, marker.sourceDbFile))) throw new MigrationError(`The original home ${source} no longer exists; refusing to remove the only copy of the data`, 'source-gone');
  const delta = postMigrationDelta(home);
  if (!delta.changed) {
    fs.rmSync(home, { recursive: true, force: true });
    return { status: 'rolled-back', to: home, source };
  }
  if (!opts.discardNewData) throw new MigrationError(`${home} contains data created after the migration. Nothing was changed. Choose explicitly: keep using it, export the new rows, or discard it.`, 'post-migration-data', delta);
  if (opts.confirm !== path.basename(home)) throw new MigrationError(`Discarding needs the confirmation value "${path.basename(home)}"`, 'confirmation-required', delta);
  const preservedAt = `${home}.discarded-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameWithRetry(home, preservedAt);
  return { status: 'discarded-preserved', to: home, source, preservedAt };
}
