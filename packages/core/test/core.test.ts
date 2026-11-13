import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Sys, emit, eventsSince, getCapability, getSettings, hashFiles, listCapabilities, normalizedHash, openSystem, overview, relate, relationsOf,
  safeRel, setSetting, snapshotProvider, upsertCapability, writeSnapshot,
} from '../src/index';

const homes: string[] = [];
export function tempSys(): Sys {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-test-'));
  homes.push(home);
  return openSystem(home);
}
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe('core', () => {
  it('schema 9 re-keys search rows by the capability rowid, keeping the indexed text, and writes no longer scan the index', () => {
    const sys = tempSys();
    upsertCapability(sys, { id: 'a.pdf', name: 'pdf-tools', description: 'Extract tables from PDF files', kind: 'skill' }, { body: 'ENTRY BODY about invoices' });
    const rid = sys.db.get<{ r: number }>("SELECT rowid r FROM capabilities WHERE id='a.pdf'")!.r;
    // Put the database back in the schema-8 shape: the search row under an unrelated rowid, migration 9 not applied.
    sys.db.run('DELETE FROM capabilities_fts WHERE rowid=?', rid);
    sys.db.run("INSERT INTO capabilities_fts (rowid, id, name, description, tags, body) VALUES (987654, 'a.pdf', 'pdf tools', 'Extract tables from PDF files', 'skill', 'ENTRY BODY about invoices')");
    sys.db.run('DELETE FROM schema_migrations WHERE version = 9');
    const home = sys.home;
    sys.close();
    const again = openSystem(home);
    expect(again.db.get<{ r: number; body: string }>("SELECT rowid r, body FROM capabilities_fts WHERE id='a.pdf'")).toEqual({ r: rid, body: 'ENTRY BODY about invoices' });
    expect(listCapabilities(again, { q: 'invoices' }).items.map((c) => c.id)).toEqual(['a.pdf']);
    // An update keeps exactly one search row, under the same rowid.
    upsertCapability(again, { id: 'a.pdf', name: 'pdf-tools', description: 'Extract tables and text from PDF files', kind: 'skill' });
    expect(again.db.all("SELECT rowid FROM capabilities_fts WHERE id='a.pdf'")).toHaveLength(1);
    again.close();
  });

  it('applies migrations once and is idempotent on reopen', () => {
    const sys = tempSys();
    const v = sys.db.get<{ v: number }>('SELECT MAX(version) v FROM schema_migrations')!.v;
    expect(v).toBeGreaterThanOrEqual(1);
    const home = sys.home;
    sys.close();
    const again = openSystem(home);
    expect(again.db.get<{ n: number }>('SELECT COUNT(*) n FROM schema_migrations')!.n).toBe(v);
    again.close();
  });

  it('registers capabilities and finds them by full-text search, ranked', () => {
    const sys = tempSys();
    upsertCapability(sys, { id: 'a.react-arch', name: 'react-architecture', description: 'Component architecture for React apps', kind: 'skill', tags: ['react', 'frontend'] }, { body: 'hooks suspense server components' });
    upsertCapability(sys, { id: 'b.k8s', name: 'kubernetes-ops', description: 'Operate Kubernetes clusters', kind: 'skill', tags: ['devops'] });
    const r = listCapabilities(sys, { q: 'react architecture' });
    expect(r.items[0].id).toBe('a.react-arch');
    expect(r.items.find((i) => i.id === 'b.k8s')).toBeUndefined();
    expect(listCapabilities(sys, { q: 'suspense' }).items[0].id).toBe('a.react-arch');
    expect(listCapabilities(sys, { kind: 'skill' }).total).toBe(2);
    expect(getCapability(sys, 'a.react-arch')!.record.permissions.shell).toBe(false);
    sys.close();
  });

  it('rejects unknown kinds via the versioned schema', () => {
    const sys = tempSys();
    expect(() => upsertCapability(sys, { id: 'x', name: 'x', kind: 'nonsense' })).toThrow();
    sys.close();
  });

  it('stores snapshots immutably and detects tampering', () => {
    const sys = tempSys();
    const files = [{ path: 'SKILL.md', content: '# hi', size: 4 }];
    const snap = writeSnapshot(sys, 'a.b', files);
    upsertCapability(sys, { id: 'a.b', name: 'b', kind: 'skill' }, snap);
    expect(snapshotProvider(sys).read('a.b')!.contentHash).toBe(hashFiles(files));
    fs.writeFileSync(path.join(snap.snapshotPath, 'SKILL.md'), '# tampered');
    expect(() => snapshotProvider(sys).read('a.b')).toThrow(/integrity/);
    sys.close();
  });

  it('refuses path traversal in packages', () => {
    expect(() => safeRel('../evil')).toThrow();
    expect(() => safeRel('C:/x')).toThrow();
    expect(safeRel('a\\b.md')).toBe('a/b.md');
  });

  it('normalised hash ignores whitespace and case', () => {
    const a = normalizedHash([{ path: 'SKILL.md', content: 'Hello   World\n', size: 1 }]);
    const b = normalizedHash([{ path: 'SKILL.md', content: 'hello world', size: 1 }]);
    expect(a).toBe(b);
  });

  it('keeps an append-only resumable event log', () => {
    const sys = tempSys();
    const first = emit(sys.db, 'test.one', 's', { a: 1 });
    emit(sys.db, 'test.two', 's');
    const after = eventsSince(sys.db, first);
    expect(after.map((e) => e.type)).toEqual(['test.two']);
    sys.close();
  });

  it('merges settings over defaults and validates keys and types', () => {
    const sys = tempSys();
    expect(getSettings(sys.db).policy.autoInstallThreshold).toBe(88);
    setSetting(sys.db, 'policy.autoInstallThreshold', 92);
    expect(getSettings(sys.db).policy.autoInstallThreshold).toBe(92);
    expect(getSettings(sys.db).policy.weights.security).toBe(20);
    expect(() => setSetting(sys.db, 'policy.nope', 1)).toThrow(/Unknown setting/);
    expect(() => setSetting(sys.db, 'policy.autoInstallThreshold', 'high')).toThrow(/expects/);
    sys.close();
  });

  it('records relations and reports real overview counters', () => {
    const sys = tempSys();
    upsertCapability(sys, { id: 'a', name: 'a', kind: 'skill' });
    upsertCapability(sys, { id: 'b', name: 'b', kind: 'agent' });
    relate(sys, 'a', 'alternative-to', 'b', 0.8, 'test');
    expect(relationsOf(sys, 'b')).toHaveLength(1);
    const o = overview(sys);
    expect(o.capabilities.total).toBe(2);
    expect(o.capabilities.byKind).toEqual({ skill: 1, agent: 1 });
    expect(o.installations.active).toBe(0);
    sys.close();
  });
});
