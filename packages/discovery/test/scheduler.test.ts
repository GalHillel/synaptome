import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DiscoveryConnector, listNotifications, recentEvents, setSetting, tempSystem, upsertCapability } from '@synaptome/core';
import { ConnectorRegistry, cadenceMs, runDueJobs, runScheduler, scan, scheduleStatus, setSourceEnabled, syncSources } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
beforeEach(() => {
  sys = tempSystem();
});
afterEach(() => sys.dispose());

function source(id: string, over: Partial<DiscoveryConnector> = {}) {
  const calls: string[] = [];
  const c: DiscoveryConnector = {
    id,
    kind: 'fixture',
    title: id,
    description: 'd',
    official: false,
    async health() {
      return { ok: true, authenticated: true, detail: 'up' };
    },
    async search(req) {
      calls.push(req.mode);
      return { drafts: [{ externalId: `${id}-x`, kind: 'skill', name: `${id}-skill`, description: 'a fixture skill with a substantive description', upstreamVersion: 'v1', licenseSpdx: 'MIT' }], requests: 1 };
    },
    async fetchPackage() {
      throw new Error('unused');
    },
    ...over,
  };
  return { c, calls };
}
const at = (iso: string) => new Date(iso);

describe('schedule status', () => {
  it('lists a due incremental and broad scan per enabled source plus an update check, and leaves out blocked and inventory sources', () => {
    const a = source('alpha');
    const reg = new ConnectorRegistry()
      .register(a.c)
      .register(source('closed', { terms: { allowed: false, basis: 'robots.txt' } }).c)
      .register(source('inventory', { kind: 'host-inventory' }).c);
    const jobs = scheduleStatus(sys, reg, at('2026-11-12T08:00:00Z'));
    expect(jobs.map((j) => j.id)).toEqual(['scan:alpha:incremental', 'scan:alpha:broad', 'updates', 'gaps']);
    expect(jobs.every((j) => j.due && j.lastRun === null)).toBe(true);
    expect(jobs.map((j) => j.cadence)).toEqual(['daily', 'weekly', 'daily', 'daily']);
  });

  it('honours cadence settings, including off, and disabled sources', () => {
    const reg = new ConnectorRegistry().register(source('alpha').c).register(source('beta').c);
    syncSources(sys, reg);
    setSetting(sys.db, 'discovery.schedule.broad', 'off');
    setSourceEnabled(sys, 'beta', false);
    const jobs = scheduleStatus(sys, reg, at('2026-11-12T08:00:00Z'));
    expect(jobs.find((j) => j.id === 'scan:alpha:broad')).toMatchObject({ cadence: 'off', nextDue: null, due: false });
    expect(jobs.some((j) => j.sourceId === 'beta')).toBe(false);
    expect(cadenceMs('hourly')).toBe(3_600_000);
    expect(cadenceMs('nonsense')).toBe(7 * 86_400_000);
  });
});

describe('running due jobs', () => {
  it('runs what is due through the normal scan, then nothing until the cadence comes round again', async () => {
    const a = source('alpha');
    const reg = new ConnectorRegistry().register(a.c);
    const first = await runDueJobs(sys, reg, { now: at('2026-11-12T08:00:00Z') });
    expect(first.ran.map((r) => [r.job, r.status])).toEqual([
      ['scan:alpha:incremental', 'completed'],
      ['scan:alpha:broad', 'completed'],
      ['updates', 'completed'],
      ['gaps', 'completed'],
    ]);
    expect(a.calls).toEqual(['incremental', 'broad']);
    expect(recentEvents(sys.db, 20, 'scan.completed').every((e) => e.origin === 'scheduler')).toBe(true);

    // an hour later nothing is due
    expect((await runDueJobs(sys, reg, { now: at('2026-11-12T09:00:00Z') })).ran).toEqual([]);
    // the scheduler reads scan history, so it sees scans recorded with their own times
    expect(scheduleStatus(sys, reg, at('2026-11-12T09:00:00Z')).find((j) => j.id === 'scan:alpha:incremental')!.lastRun).toBeTruthy();
    // a day later only the daily jobs are due
    const nextDay = await runDueJobs(sys, reg, { now: at('2026-11-13T09:00:00Z') });
    expect(nextDay.ran.map((r) => r.job)).toEqual(['scan:alpha:incremental', 'updates', 'gaps']);
  });

  it('still applies gates: a due job for a source that is backing off is reported as skipped with the reason', async () => {
    let up = false;
    const a = source('flaky', {
      async health() {
        return up ? { ok: true, authenticated: true, detail: 'up' } : { ok: false, authenticated: false, detail: 'HTTP 503' };
      },
    });
    const reg = new ConnectorRegistry().register(a.c);
    await runDueJobs(sys, reg, { now: at('2026-11-12T08:00:00Z') });
    const status = scheduleStatus(sys, reg, at('2026-11-12T08:01:00Z'));
    expect(status.find((j) => j.id === 'scan:flaky:incremental')!.waiting).toMatch(/backing off/);
    up = true;
    expect(a.calls).toEqual([]);
  });

  it('tells a person when an approved or installed capability has an update, and never applies it', async () => {
    const versions = { current: 'v1' };
    const a = source('alpha', {
      async checkUpdate(c) {
        return versions.current !== c.upstreamVersion ? { changed: true, version: versions.current, detail: `v1 -> ${versions.current}` } : { changed: false, version: versions.current };
      },
    });
    const reg = new ConnectorRegistry().register(a.c);
    syncSources(sys, reg);
    await scan(sys, a.c, { mode: 'broad', now: at('2026-11-12T07:00:00Z') });
    const cand = sys.db.get<{ id: string }>('SELECT id FROM candidates')!;
    sys.db.run("UPDATE candidates SET state = 'registered' WHERE id = ?", cand.id);
    upsertCapability(sys, { id: 'alpha.skill', name: 'alpha-skill', description: 'd', kind: 'skill' }, { status: 'approved', candidateId: cand.id, reason: 'test', by: 'test' });

    versions.current = 'v2';
    await runDueJobs(sys, reg, { now: at('2026-11-12T08:00:00Z') });
    const n = listNotifications(sys, { unreadOnly: true });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ level: 'action', kind: 'capability.update', subject: 'alpha.skill' });
    expect(n[0].body).toMatch(/Nothing is applied automatically/);
    expect(sys.db.get<{ status: string }>("SELECT status FROM capabilities WHERE id = 'alpha.skill'")!.status).toBe('approved');
    // the same pending update is not announced twice
    await runDueJobs(sys, reg, { now: at('2026-11-13T08:00:00Z') });
    expect(listNotifications(sys, { unreadOnly: true })).toHaveLength(1);
  });
});

describe('foreground loop', () => {
  it('runs passes until stopped', async () => {
    const reg = new ConnectorRegistry().register(source('alpha').c);
    const stop = new AbortController();
    const passes: number[] = [];
    await runScheduler(sys, reg, {
      intervalMs: 5,
      signal: stop.signal,
      onRun: (r) => {
        passes.push(r.ran.length);
        if (passes.length === 3) stop.abort();
      },
    });
    expect(passes[0]).toBe(4);
    expect(passes.slice(1)).toEqual([0, 0]);
  });
});

describe('gap-driven discovery', () => {
  it('searches recurring open gaps on free-text sources, at most once a week per gap', async () => {
    const queries: string[] = [];
    const searchable = (id: string) =>
      source(id, {
        async search(req) {
          if (req.mode === 'need') queries.push(`${id}:${req.query}`);
          return { drafts: req.mode === 'need' ? [{ externalId: `${id}-${req.query}`, kind: 'skill', name: String(req.query), description: 'found for a gap, with a substantive description' }] : [], requests: 1 };
        },
      }).c;
    const reg = new ConnectorRegistry().register(searchable('github')).register(searchable('npm'));
    const now = '2026-11-12T08:00:00Z';
    const gap = (term: string, hits: number) => sys.db.run("INSERT INTO gaps (term, domain, hits, sample_task, status, first_seen_at, last_seen_at) VALUES (?, 'x', ?, 't', 'open', ?, ?)", term, hits, now, now);
    gap('webgl configurator', 4);
    gap('cobol batch', 2);
    gap('seen once', 1);
    sys.db.run("INSERT INTO gaps (term, domain, hits, sample_task, status, first_seen_at, last_seen_at) VALUES ('closed gap', 'x', 9, 't', 'closed', ?, ?)", now, now);

    const r = await runDueJobs(sys, reg, { now: at(now) });
    expect(r.ran.find((x) => x.job === 'gaps')!.detail).toMatch(/searched "webgl configurator", "cobol batch": 4 new/);
    expect(queries.sort()).toEqual(['github:cobol batch', 'github:webgl configurator', 'npm:cobol batch', 'npm:webgl configurator']);

    // the next day the gaps job runs again, but those gaps were searched within the week
    queries.length = 0;
    const next = await runDueJobs(sys, reg, { now: at('2026-11-13T09:00:00Z') });
    expect(next.ran.find((x) => x.job === 'gaps')!.detail).toBe('no recurring gaps to search');
    expect(queries).toEqual([]);
    // eight days later they are due again
    await runDueJobs(sys, reg, { now: at('2026-11-20T09:00:00Z') });
    expect(queries.length).toBe(4);
  });
});

describe('duplicates across sources', () => {
  it('links the same repository unit reached through different sources to the first candidate', async () => {
    const unit = (n: number) => ({ externalId: `acme/repo-${n}:skills/s${n}#skill`, kind: 'skill' as const, name: `s${n}`, description: 'the same unit seen through several sources', repo: `acme/repo-${n}`, path: `skills/s${n}` });
    const N = 40;
    const via = (id: string) => source(id, { async search() { return { drafts: Array.from({ length: N }, (_, i) => unit(i)), requests: 1 }; } }).c;
    const reg = new ConnectorRegistry().register(via('github')).register(via('official-skills')).register(via('curated-lists'));
    syncSources(sys, reg);
    for (const id of ['github', 'official-skills', 'curated-lists']) await scan(sys, reg.get(id), { mode: 'broad', limit: N, now: at('2026-11-12T08:00:00Z') });
    const rows = sys.db.all<{ source_id: string; duplicate_of: string | null; recommended_action: string }>('SELECT source_id, duplicate_of, recommended_action FROM candidates');
    expect(rows).toHaveLength(3 * N);
    const later = rows.filter((r) => r.source_id !== 'github');
    const detected = later.filter((r) => r.duplicate_of).length / later.length;
    expect(detected).toBeGreaterThanOrEqual(0.95);
    expect(later.every((r) => r.recommended_action === 'skip-duplicate')).toBe(true);
    expect(rows.filter((r) => r.source_id === 'github').every((r) => !r.duplicate_of)).toBe(true);
  });
});
