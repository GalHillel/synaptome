import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleError, MIGRATIONS, PRODUCT, TRANSITIONS, canTransition, capabilityHistory, getCapability, listCapabilities, openSystem, recentEvents, setCapabilityStatus, tempSystem, transitionCapability, upsertCapability } from '../src';

let sys: ReturnType<typeof tempSystem>;
const add = (id: string, extra: Record<string, unknown> = {}, status?: 'registered' | 'approved') =>
  upsertCapability(sys, { id, name: id.split('.')[1], description: 'test capability', kind: 'skill', ...extra }, { status, reason: 'test fixture', by: 'test' });
beforeEach(() => {
  sys = tempSystem();
});
afterEach(() => sys.dispose());

describe('capability lifecycle', () => {
  it('records creation and every allowed transition with its reason, actor and an event', () => {
    add('t.one');
    transitionCapability(sys, 't.one', 'approved', { reason: 'gate passed', by: 'policy' });
    transitionCapability(sys, 't.one', 'registered', { reason: 'upstream changed', by: 'update' });
    transitionCapability(sys, 't.one', 'rejected', { reason: 'not useful', by: 'user' });
    const h = capabilityHistory(sys, 't.one');
    expect(h.map((x) => [x.from, x.to, x.by])).toEqual([
      [null, 'registered', 'test'],
      ['registered', 'approved', 'policy'],
      ['approved', 'registered', 'update'],
      ['registered', 'rejected', 'user'],
    ]);
    expect(h[3].reason).toBe('not useful');
    expect(recentEvents(sys.db, 10, 'capability.rejected')[0]).toMatchObject({ subject: 't.one', payload: { from: 'registered', reason: 'not useful', by: 'user' } });
    expect(getCapability(sys, 't.one')!.status).toBe('rejected');
  });

  it('refuses a transition the lifecycle does not allow, and changes nothing', () => {
    add('t.two');
    transitionCapability(sys, 't.two', 'rejected', { reason: 'no', by: 'user' });
    expect(() => transitionCapability(sys, 't.two', 'approved', { reason: 'try anyway', by: 'user' })).toThrow(LifecycleError);
    expect(getCapability(sys, 't.two')!.status).toBe('rejected');
    expect(capabilityHistory(sys, 't.two')).toHaveLength(2);
    // the only way back is to be registered again, and from there through the gate
    for (const from of ['rejected', 'blocked', 'deprecated'] as const) {
      expect(canTransition(from, 'approved')).toBe(false);
      expect(TRANSITIONS[from]).toEqual(['registered']);
    }
  });

  it('requires a reason, refuses unknown capabilities, and treats a same-status change as a no-op', () => {
    add('t.three');
    expect(() => transitionCapability(sys, 't.three', 'approved', { reason: '  ', by: 'user' })).toThrow(/reason is required/);
    expect(() => transitionCapability(sys, 't.missing', 'approved', { reason: 'x', by: 'user' })).toThrow(/No capability/);
    expect(transitionCapability(sys, 't.three', 'registered', { reason: 'already', by: 'user' })).toBeNull();
    expect(capabilityHistory(sys, 't.three')).toHaveLength(1);
  });

  it('applies the same rules to status changes made through an upsert and to setCapabilityStatus', () => {
    add('t.four');
    setCapabilityStatus(sys, 't.four', 'blocked', 'critical audit finding');
    expect(() => add('t.four', {}, 'approved')).toThrow(LifecycleError);
    expect(getCapability(sys, 't.four')!.status).toBe('blocked');
    add('t.four', { description: 'fixed' }, 'registered');
    expect(capabilityHistory(sys, 't.four').map((x) => x.to)).toEqual(['registered', 'blocked', 'registered']);
  });

  it('writes the status change and its record atomically', () => {
    add('t.five');
    // A failing extra assignment aborts the whole transition: no status change, no history row, no event.
    expect(() => transitionCapability(sys, 't.five', 'approved', { reason: 'x', by: 'user', extraSql: 'no_such_column = 1' })).toThrow();
    expect(getCapability(sys, 't.five')!.status).toBe('registered');
    expect(capabilityHistory(sys, 't.five')).toHaveLength(1);
    expect(recentEvents(sys.db, 10, 'capability.approved')).toHaveLength(0);
  });

  it('is the only code that writes a capability status', () => {
    const roots = ['packages', 'apps'].map((d) => path.resolve(__dirname, '..', '..', '..', d));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!['node_modules', 'test', 'dist'].includes(e.name)) walk(full);
        } else if (/\.tsx?$/.test(e.name) && !full.endsWith(path.join('core', 'src', 'lifecycle.ts')) && /UPDATE\s+capabilities\s+SET\s+status/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});

describe('schema v2', () => {
  it('upgrades a version-1 database in place: backup first, history seeded, new tables, trigger statements searchable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-v1-'));
    try {
      // Build a version-1 database by hand, the way a milestone-1 installation left it.
      const dbFile = path.join(home, PRODUCT.dbFile);
      const raw = new DatabaseSync(dbFile);
      raw.exec('PRAGMA journal_mode=WAL;');
      raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      raw.exec(MIGRATIONS[0].sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(MIGRATIONS[0].name, '2026-11-11T00:00:00Z');
      const record = { id: 'legacy.comms', name: 'comms', description: 'Internal writing.', kind: 'skill', domain: 'docs', tags: ['writing'], activation: ['Use whenever asked for leadership updates or 3P updates', 'requires: update'] };
      raw.prepare('INSERT INTO capabilities (id, schema_version, name, description, kind, domain, category, tags, origin, status, record, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy.comms', 1, 'comms', 'Internal writing.', 'skill', 'docs', '', '["writing"]', 'discovered', 'approved', JSON.stringify(record), 'now', 'now');
      raw.prepare('INSERT INTO capabilities_fts (id, name, description, tags, body) VALUES (?,?,?,?,?)').run('legacy.comms', 'comms', 'Internal writing.', 'writing docs skill', '');
      raw.close();

      const s = openSystem(home);
      try {
        expect(s.db.get<{ v: number }>('SELECT MAX(version) v FROM schema_migrations')!.v).toBe(MIGRATIONS.length);
        expect(fs.readdirSync(path.join(home, 'backups')).some((f) => /-pre-v2-/.test(f))).toBe(true);
        expect(capabilityHistory(s, 'legacy.comms')).toEqual([expect.objectContaining({ from: null, to: 'approved', by: 'migration' })]);
        for (const t of ['dependencies', 'notifications', 'source_checks', 'capability_transitions']) expect(s.db.get('SELECT name FROM sqlite_master WHERE name = ?', t)).toBeTruthy();
        expect(s.db.all('PRAGMA table_info(sources)').map((c: any) => c.name)).toEqual(expect.arrayContaining(['failures', 'backoff_until', 'budget', 'terms']));
        // the trigger statement is now searchable; the structured condition line is not indexed as words
        expect(listCapabilities(s, { q: 'leadership' }).items.map((c) => c.id)).toEqual(['legacy.comms']);
        const tags = s.db.get<{ tags: string }>('SELECT tags FROM capabilities_fts WHERE id = ?', 'legacy.comms')!.tags;
        expect(tags).toContain('3P updates');
        expect(tags).not.toContain('requires:');
        // and the lifecycle works on the upgraded data
        transitionCapability(s, 'legacy.comms', 'deprecated', { reason: 'superseded', by: 'test' });
        expect(capabilityHistory(s, 'legacy.comms')).toHaveLength(2);
      } finally {
        s.close();
      }
      // opening again applies nothing new
      const again = openSystem(home);
      expect(again.db.get<{ n: number }>('SELECT COUNT(*) n FROM schema_migrations')!.n).toBe(MIGRATIONS.length);
      again.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
