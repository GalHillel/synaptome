import { afterEach, describe, expect, it } from 'vitest';
import { type CandidateDraft, type DiscoveryConnector, getCandidate, listCandidates, recentEvents, setSetting, tempSystem } from '@synaptome/core';
import { ConnectorRegistry, checkUpdates, evaluationQueue, listSources, rankDraft, scan, scanAll, scanHistory, schedulePlan, syncSources } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
afterEach(() => sys?.dispose());

/** A connector defined entirely in this test file: proves new sources need no change to core or the engine. */
function fixtureConnector(id: string, drafts: () => CandidateDraft[], over: Partial<DiscoveryConnector> = {}): DiscoveryConnector {
  return {
    id,
    kind: 'fixture',
    title: `Fixture ${id}`,
    description: 'test source',
    official: false,
    health: async () => ({ ok: true, detail: 'fine', authenticated: false }),
    search: async () => ({ drafts: drafts(), cursor: { seen: true }, notes: ['fixture note'] }),
    fetchPackage: async () => ({ files: [], skipped: [], provenance: { url: 'x', method: 'fixture', verified: false } }),
    ...over,
  };
}
const draft = (over: Partial<CandidateDraft> = {}): CandidateDraft => ({
  externalId: 'acme/skills:pdf#skill', kind: 'skill', name: 'pdf-tools', description: 'Extract text and tables from PDF documents reliably', repo: 'acme/skills', path: 'pdf',
  ref: 'a'.repeat(40), upstreamVersion: 'tree1', publisher: 'acme', licenseSpdx: 'MIT', stars: 1200, pushedAt: new Date().toISOString(), topics: ['agent-skills'], ...over,
});

describe('discovery engine', () => {
  it('turns search results into normalized, ranked, queued candidates with history', async () => {
    sys = tempSystem();
    const reg = new ConnectorRegistry().register(fixtureConnector('fx', () => [draft()]));
    syncSources(sys, reg);
    const r = await scan(sys, reg.get('fx'), { mode: 'broad' });
    expect(r).toMatchObject({ status: 'completed', found: 1, added: 1, queued: 1 });
    const c = getCandidate(sys, r.candidateIds[0])!;
    expect(c).toMatchObject({ kind: 'skill', name: 'pdf-tools', state: 'queued', recommendedAction: 'evaluate', licenseSpdx: 'MIT', repo: 'acme/skills' });
    expect(c.rank).toBeGreaterThanOrEqual(50);
    expect(c.rankReasons.join(' ')).toMatch(/licence MIT/);
    expect(scanHistory(sys)[0]).toMatchObject({ source_id: 'fx', status: 'completed', added: 1 });
    expect(listSources(sys, reg)[0]).toMatchObject({ id: 'fx', health: 'healthy', candidates: 1 });
    expect(evaluationQueue(sys).map((x) => x.id)).toEqual([c.id]);
    expect(recentEvents(sys.db, 20).map((e) => e.type)).toEqual(expect.arrayContaining(['scan.started', 'candidate.discovered', 'scan.completed']));
  });

  it('is incremental: unchanged on rescan, flags upstream change without overwriting audited data', async () => {
    sys = tempSystem();
    let version = 'tree1';
    const reg = new ConnectorRegistry().register(fixtureConnector('fx', () => [draft({ upstreamVersion: version, ref: version === 'tree1' ? 'a'.repeat(40) : 'b'.repeat(40) })]));
    syncSources(sys, reg);
    const first = await scan(sys, reg.get('fx'), { mode: 'broad' });
    expect((await scan(sys, reg.get('fx'), { mode: 'incremental' })).unchanged).toBe(1);
    sys.db.run("UPDATE candidates SET state='audited' WHERE id=?", first.candidateIds[0]);
    version = 'tree2';
    const third = await scan(sys, reg.get('fx'), { mode: 'incremental' });
    expect(third.updated).toBe(1);
    const c = getCandidate(sys, first.candidateIds[0])!;
    expect(c.updateAvailable).toBe(true);
    expect(c.ref).toBe('a'.repeat(40)); // pinned audited ref is preserved
    expect(c.signals.upstreamRef).toBe('b'.repeat(40));
  });

  it('flags the same unit reported by two sources as a duplicate, and similar units as overlap', async () => {
    sys = tempSystem();
    const reg = new ConnectorRegistry()
      .register(fixtureConnector('one', () => [draft()]))
      .register(fixtureConnector('two', () => [draft({ externalId: 'mirror:pdf' }), draft({ externalId: 'other/x:pdf', repo: 'other/x', name: 'pdf-toolkit', description: 'Extract tables and text from PDF documents' })]));
    const reports = await scanAll(sys, reg, { mode: 'broad' });
    const dup = getCandidate(sys, reports[1].candidateIds[0])!;
    expect(dup.duplicateOf).toBe(reports[0].candidateIds[0]);
    expect(dup.recommendedAction).toBe('skip-duplicate');
    expect(dup.state).toBe('discovered');
    const similar = getCandidate(sys, reports[1].candidateIds[1])!;
    expect(similar.duplicateOf).toBeNull();
    expect(similar.overlap.length).toBeGreaterThan(0);
    expect(listCandidates(sys).total).toBe(3); // nothing merged
  });

  it('reports a search that stopped early (a rate limit) as partial, with the reason, keeping what it found', async () => {
    sys = tempSystem();
    const reg = new ConnectorRegistry().register(fixtureConnector('limited', () => [draft()], { search: async () => ({ drafts: [draft()], notes: [], stoppedEarly: 'GitHub core rate limit reached; resets at 07:19' }) }));
    syncSources(sys, reg);
    const r = await scan(sys, reg.get('limited'), { mode: 'broad' });
    expect(r).toMatchObject({ status: 'partial', found: 1, added: 1, error: expect.stringMatching(/rate limit/) });
    expect(recentEvents(sys.db, 5).map((e) => e.type)).toContain('scan.partial');
  });

  it('records failed health as an unavailable source and a failed scan', async () => {
    sys = tempSystem();
    const reg = new ConnectorRegistry().register(fixtureConnector('down', () => [], { health: async () => ({ ok: false, detail: 'HTTP 503', authenticated: false }) }));
    syncSources(sys, reg);
    const r = await scan(sys, reg.get('down'), { mode: 'broad' });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/503/);
    expect(listSources(sys, reg)[0].health).toBe('unavailable');
  });

  it('skips sources disabled in settings', async () => {
    sys = tempSystem();
    setSetting(sys.db, 'discovery.disabledSources', ['fx']);
    const reg = new ConnectorRegistry().register(fixtureConnector('fx', () => [draft()]));
    const [r] = await scanAll(sys, reg, { mode: 'broad' });
    expect(r.status).toBe('skipped');
    expect(listCandidates(sys).total).toBe(0);
  });

  it('ranks with explicit reasons: disallowed licence and deny-listed publisher sink a candidate', () => {
    sys = tempSystem();
    const settings = sys.settings();
    const good = rankDraft(draft({ publisher: 'anthropics' }), { official: false, settings });
    const gpl = rankDraft(draft({ licenseSpdx: 'GPL-3.0' }), { official: false, settings });
    const none = rankDraft(draft({ licenseSpdx: undefined }), { official: false, settings });
    expect(good.rank).toBeGreaterThan(gpl.rank);
    expect(none.reasons.join(' ')).toMatch(/licence not stated/);
    settings.policy.denyPublishers = ['acme'];
    expect(rankDraft(draft(), { official: false, settings }).rank).toBeLessThan(20);
  });

  it('checks acquired candidates for updates through the connector', async () => {
    sys = tempSystem();
    const reg = new ConnectorRegistry().register(fixtureConnector('fx', () => [draft()], { checkUpdate: async () => ({ changed: true, ref: 'c'.repeat(40), detail: 'moved' }) }));
    syncSources(sys, reg);
    const r = await scan(sys, reg.get('fx'), { mode: 'broad' });
    sys.db.run("UPDATE candidates SET state='registered' WHERE id=?", r.candidateIds[0]);
    const u = await checkUpdates(sys, reg);
    expect(u[0]).toMatchObject({ changed: true });
    expect(getCandidate(sys, r.candidateIds[0])!.updateAvailable).toBe(true);
  });

  it('produces a visible schedule plan instead of registering hidden tasks', () => {
    sys = tempSystem();
    const plan = schedulePlan('synaptome', sys.settings());
    expect(plan).toHaveLength(1);
    expect(plan[0].windows.create).toMatch(/^schtasks \/Create \/TN "Synaptome Scheduler" \/SC HOURLY \/TR "synaptome scheduler run --once"/);
    expect(plan[0].cron).toBe('0 * * * * synaptome scheduler run --once');
  });
});
