import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY, MIGRATION_MARKER, MigrationError, PRODUCT, emit, env, exportPostMigrationDelta, isLegacyHome, migrateHome, openSystem, postMigrationDelta, resolveHome, rollbackMigration, writeSnapshot } from '../src';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/** `strict` also reports empty write-ahead-log sidecars; the source is always checked strictly. */
function tree(dir: string, strict = true): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (!e.name.endsWith('-shm') && (strict || !(e.name.endsWith('-wal') && fs.statSync(full).size === 0))) out[path.relative(dir, full).replace(/\\/g, '/')] = sha(full);
    }
  };
  walk(dir);
  return out;
}

/** Builds a home exactly as the previous product version left it: legacy database, manifest and marker names. */
function legacyHome(): { root: string; from: string; to: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-migrate-'));
  roots.push(root);
  const from = path.join(root, 'old-home');
  const to = path.join(root, 'new-home');
  const sys = openSystem(from);
  const snap = writeSnapshot(sys, 'acme.example-skill', [
    { path: 'SKILL.md', content: '---\nname: example-skill\n---\nBody\n', size: 33 },
    { path: 'references/notes.md', content: 'notes\n', size: 6 },
  ]);
  emit(sys.db, 'test.created', 'acme.example-skill', { at: path.join(from, 'store') });
  emit(sys.db, 'test.second', null, { n: 2 });
  sys.db.run('INSERT INTO forge_candidates (id, gap, name, state, path, record, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', 'f-1', 'gap', 'forged', 'draft', path.join(from, 'forge', 'f-1'), JSON.stringify({ workspace: path.join(from, 'forge', 'f-1') }), 'now', 'now');
  sys.close();
  // Rename to the names the previous version used.
  fs.renameSync(path.join(from, PRODUCT.dbFile), path.join(from, LEGACY.dbFile));
  fs.renameSync(path.join(snap.snapshotPath, PRODUCT.manifestFile), path.join(snap.snapshotPath, LEGACY.manifestFile));
  const installed = path.join(from, 'sandbox-hosts', 'claude-code', 'skills', 'example-skill');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'SKILL.md'), 'Body\n');
  fs.writeFileSync(path.join(installed, LEGACY.markerFile), JSON.stringify({ managedBy: LEGACY.managedBy, capabilityId: 'acme.example-skill' }));
  fs.mkdirSync(path.join(from, 'forge', 'f-1'), { recursive: true });
  fs.writeFileSync(path.join(from, 'forge', 'f-1', 'SKILL.md'), 'draft\n');
  return { root, from, to };
}
const count = (home: string, table: string, file: string = PRODUCT.dbFile) => {
  const db = new DatabaseSync(path.join(home, file), { readOnly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
};

describe('identity and home resolution', () => {
  it('prefers the explicit home, then the current variable, then the legacy variable', () => {
    const saved = { a: process.env.SYNAPTOME_HOME, b: process.env.DRELQAVO_HOME };
    try {
      delete process.env.SYNAPTOME_HOME;
      delete process.env.DRELQAVO_HOME;
      expect(resolveHome()).toMatch(new RegExp(`${PRODUCT.dataDir}$`));
      process.env.DRELQAVO_HOME = path.join(os.tmpdir(), 'legacy-env-home');
      expect(resolveHome()).toBe(path.resolve(os.tmpdir(), 'legacy-env-home'));
      expect(env('HOME')).toBe(process.env.DRELQAVO_HOME);
      process.env.SYNAPTOME_HOME = path.join(os.tmpdir(), 'current-env-home');
      expect(resolveHome()).toBe(path.resolve(os.tmpdir(), 'current-env-home'));
      expect(resolveHome(path.join(os.tmpdir(), 'explicit'))).toBe(path.resolve(os.tmpdir(), 'explicit'));
    } finally {
      if (saved.a === undefined) delete process.env.SYNAPTOME_HOME;
      else process.env.SYNAPTOME_HOME = saved.a;
      if (saved.b === undefined) delete process.env.DRELQAVO_HOME;
      else process.env.DRELQAVO_HOME = saved.b;
    }
  });

  it('refuses to open an un-migrated legacy home and writes nothing into it', () => {
    const { from } = legacyHome();
    const before = tree(from);
    expect(isLegacyHome(from)).toBe(true);
    expect(() => openSystem(from)).toThrow(/has not been migrated/);
    expect(tree(from)).toEqual(before);
    expect(fs.existsSync(path.join(from, PRODUCT.dbFile))).toBe(false);
  });
});

describe('home migration', () => {
  it('copies a legacy home without touching it, renames legacy files, rewrites paths and stays usable', async () => {
    const { from, to } = legacyHome();
    const before = tree(from);
    const r = await migrateHome({ from, to });

    expect(r.status).toBe('migrated');
    expect(r.integrity).toBe('ok');
    expect(r.source.untouched).toBe(true);
    expect(tree(from)).toEqual(before); // every source file byte-identical
    expect(r.tables.events).toBe(2);
    expect(count(to, 'events')).toBe(2); // (the source is not opened here: even a read-only connection would create sidecar files in it)
    expect(r.snapshotsVerified).toBe(1);
    expect(r.renamedFiles).toBe(2);

    // legacy file names are gone from the copy; ownership marker now names the product
    const copied = Object.keys(tree(to));
    expect(copied.some((f) => f.endsWith(LEGACY.manifestFile) || f.endsWith(LEGACY.markerFile) || f === LEGACY.dbFile)).toBe(false);
    const marker = JSON.parse(fs.readFileSync(path.join(to, 'sandbox-hosts', 'claude-code', 'skills', 'example-skill', PRODUCT.markerFile), 'utf8'));
    expect(marker).toMatchObject({ managedBy: PRODUCT.managedBy, capabilityId: 'acme.example-skill' });

    // absolute paths now point into the new home; recorded history keeps what it recorded
    const sys = openSystem(to);
    try {
      const row = sys.db.get<{ path: string; record: string }>('SELECT path, record FROM forge_candidates WHERE id = ?', 'f-1')!;
      expect(row.path).toBe(path.join(to, 'forge', 'f-1'));
      expect(JSON.parse(row.record).workspace).toBe(path.join(to, 'forge', 'f-1'));
      const ev = sys.db.get<{ payload: string }>("SELECT payload FROM events WHERE type = 'test.created'")!;
      expect(JSON.parse(ev.payload).at).toBe(path.join(from, 'store'));
      expect(r.rewrittenPathValues).toBeGreaterThanOrEqual(2);
      emit(sys.db, 'after.migration', null, {}); // the migrated home accepts writes
    } finally {
      sys.close();
    }
    expect(tree(from)).toEqual(before);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { from, to } = legacyHome();
    await migrateHome({ from, to });
    const after = tree(to);
    const again = await migrateHome({ from, to });
    expect(again.status).toBe('already-migrated');
    expect(tree(to)).toEqual(after);
  });

  it('reports without writing on a dry run', async () => {
    const { from, to } = legacyHome();
    const r = await migrateHome({ from, to, dryRun: true });
    expect(r.status).toBe('dry-run');
    expect(r.tables.events).toBe(2);
    expect(fs.existsSync(to)).toBe(false);
  });

  it('takes one consistent snapshot while another connection holds uncheckpointed WAL writes', async () => {
    const { from, to } = legacyHome();
    const writer = new DatabaseSync(path.join(from, LEGACY.dbFile));
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      const ins = writer.prepare('INSERT INTO events (ts, type, subject, origin, payload) VALUES (?,?,?,?,?)');
      for (let i = 0; i < 50; i++) ins.run('t', 'wal.row', null, 'test', '{}');
      const dbBefore = sha(path.join(from, LEGACY.dbFile));
      const walBefore = sha(path.join(from, `${LEGACY.dbFile}-wal`));
      expect(fs.statSync(path.join(from, `${LEGACY.dbFile}-wal`)).size).toBeGreaterThan(0);

      const r = await migrateHome({ from, to });
      expect(r.status).toBe('migrated');
      expect(count(to, 'events')).toBe(52); // rows that existed only in the WAL are in the copy
      // the migration did not checkpoint or rewrite the source
      expect(sha(path.join(from, LEGACY.dbFile))).toBe(dbBefore);
      expect(sha(path.join(from, `${LEGACY.dbFile}-wal`))).toBe(walBefore);

      // the writer is still fully functional afterwards
      ins.run('t', 'after.copy', null, 'test', '{}');
      expect(Number((writer.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n)).toBe(53);
    } finally {
      writer.close();
    }
  });

  it.each(['after-db-copy', 'after-files', 'before-rename'] as const)('leaves no destination when interrupted %s, and the next run recovers', async (point) => {
    const { root, from, to } = legacyHome();
    const before = tree(from);
    await expect(migrateHome({ from, to, interruptAt: point })).rejects.toMatchObject({ code: 'interrupted' });
    expect(fs.existsSync(to)).toBe(false);
    expect(fs.readdirSync(root).some((e) => e.startsWith('new-home.migrating-'))).toBe(true); // what a crash would leave behind
    const r = await migrateHome({ from, to });
    expect(r.status).toBe('migrated');
    expect(fs.readdirSync(root).some((e) => e.startsWith('new-home.migrating-'))).toBe(false);
    expect(count(to, 'events')).toBe(2);
    expect(tree(from)).toEqual(before);
  });

  it('rejects a corrupted source database and creates nothing', async () => {
    const { root, from, to } = legacyHome();
    const dbPath = path.join(from, LEGACY.dbFile);
    const buf = fs.readFileSync(dbPath);
    buf.fill(0x5a, 4096, Math.min(buf.length, 4096 * 6));
    fs.writeFileSync(dbPath, buf);
    await expect(migrateHome({ from, to })).rejects.toThrow();
    expect(fs.existsSync(to)).toBe(false);
    expect(fs.readdirSync(root).some((e) => e.startsWith('new-home.migrating-'))).toBe(false);
  });

  it('rejects a snapshot whose content no longer matches its manifest', async () => {
    const { root, from, to } = legacyHome();
    const snapDir = fs.readdirSync(path.join(from, 'store', 'acme-example-skill'))[0];
    fs.writeFileSync(path.join(from, 'store', 'acme-example-skill', snapDir, 'SKILL.md'), 'tampered\n');
    await expect(migrateHome({ from, to })).rejects.toMatchObject({ code: 'snapshot-hash-mismatch' });
    expect(fs.existsSync(to)).toBe(false);
    expect(fs.readdirSync(root).some((e) => e.startsWith('new-home.migrating-'))).toBe(false);
  });

  it('refuses a missing source, a non-home source, a destination with content and a destination inside the source', async () => {
    const { root, from, to } = legacyHome();
    await expect(migrateHome({ from: path.join(root, 'nope'), to })).rejects.toMatchObject({ code: 'source-missing' });
    fs.mkdirSync(path.join(root, 'empty'));
    await expect(migrateHome({ from: path.join(root, 'empty'), to })).rejects.toMatchObject({ code: 'source-not-a-home' });
    await expect(migrateHome({ from, to: path.join(from, 'inner') })).rejects.toMatchObject({ code: 'destination-inside-source' });
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, 'someone-elses.txt'), 'keep me');
    await expect(migrateHome({ from, to })).rejects.toMatchObject({ code: 'destination-not-empty' });
    expect(fs.readFileSync(path.join(to, 'someone-elses.txt'), 'utf8')).toBe('keep me');
  });
});

describe('migration rollback', () => {
  it('removes an unchanged migrated home and leaves the original intact', async () => {
    const { from, to } = legacyHome();
    const before = tree(from);
    await migrateHome({ from, to });
    expect(postMigrationDelta(to).changed).toBe(false);
    const r = rollbackMigration(to);
    expect(r.status).toBe('rolled-back');
    expect(fs.existsSync(to)).toBe(false);
    expect(tree(from)).toEqual(before);
    // and the migration can be run again afterwards
    expect((await migrateHome({ from, to })).status).toBe('migrated');
  });

  it('refuses to roll back over data created after the migration, and only sets it aside on an explicit, confirmed choice', async () => {
    const { from, to } = legacyHome();
    await migrateHome({ from, to });
    const sys = openSystem(to);
    emit(sys.db, 'work.after.migration', 'x', { important: true });
    writeSnapshot(sys, 'acme.new-skill', [{ path: 'SKILL.md', content: 'new\n', size: 4 }]);
    sys.close();
    const withNewData = tree(to, false);

    const delta = postMigrationDelta(to);
    expect(delta.changed).toBe(true);
    expect(delta.tables.events).toEqual({ atMigration: 2, now: 3 });
    expect(delta.treeChanged).toBe(true);

    let refusal: unknown;
    try {
      rollbackMigration(to);
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(MigrationError);
    expect((refusal as MigrationError).code).toBe('post-migration-data');
    expect(tree(to, false)).toEqual(withNewData); // nothing was changed by the refusal

    const exported = exportPostMigrationDelta(to);
    expect(exported.rows).toBe(1);
    expect(JSON.parse(fs.readFileSync(exported.file, 'utf8')).tables.events[0].type).toBe('work.after.migration');

    expect(() => rollbackMigration(to, { discardNewData: true })).toThrow(/confirmation/);
    expect(() => rollbackMigration(to, { discardNewData: true, confirm: 'wrong' })).toThrow(/confirmation/);
    expect(fs.existsSync(to)).toBe(true);

    const r = rollbackMigration(to, { discardNewData: true, confirm: 'new-home' });
    expect(r.status).toBe('discarded-preserved');
    expect(fs.existsSync(to)).toBe(false);
    expect(count(r.preservedAt!, 'events')).toBe(3); // set aside, not deleted
    expect(fs.existsSync(path.join(r.preservedAt!, MIGRATION_MARKER))).toBe(true);
  });

  it('refuses when the original home is gone or the directory was not created by a migration', async () => {
    const { root, from, to } = legacyHome();
    await migrateHome({ from, to });
    fs.renameSync(from, path.join(root, 'moved-away'));
    expect(() => rollbackMigration(to)).toThrow(/no longer exists/);
    expect(fs.existsSync(to)).toBe(true);
    const plain = path.join(root, 'plain');
    openSystem(plain).close();
    expect(() => rollbackMigration(plain)).toThrow(/not created by a migration/);
    expect(fs.existsSync(path.join(plain, PRODUCT.dbFile))).toBe(true);
  });
});
