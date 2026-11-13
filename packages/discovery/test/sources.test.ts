import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DiscoveryConnector, getSettings, listNotifications, markNotificationsRead, recentEvents, tempSystem } from '@synaptome/core';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, ConnectorRegistry, backoffDelayMs, listSources, scan, setSourceBudget, setSourceEnabled, sourceChecks, sourceGate, syncSources } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
beforeEach(() => {
  sys = tempSystem();
});
afterEach(() => sys.dispose());

/** A source whose availability the test controls. Counts every call so "no request was made" is checkable. */
function controllable(id: string, over: Partial<DiscoveryConnector> = {}) {
  const state = { up: true, healthCalls: 0, searchCalls: 0, lastLimit: 0 };
  const c: DiscoveryConnector = {
    id,
    kind: 'fixture',
    title: id,
    description: 'test source',
    official: false,
    async health() {
      state.healthCalls++;
      return state.up ? { ok: true, authenticated: true, detail: 'up' } : { ok: false, authenticated: false, detail: 'HTTP 503' };
    },
    async search(req) {
      state.searchCalls++;
      state.lastLimit = req.limit;
      return { drafts: Array.from({ length: req.limit }, (_, i) => ({ externalId: `${id}-${i}`, kind: 'skill' as const, name: `skill-${i}`, description: 'a fixture skill with a substantive description' })), requests: 3 };
    },
    async fetchPackage() {
      throw new Error('not used');
    },
    ...over,
  };
  syncSources(sys, new ConnectorRegistry().register(c));
  return { c, state };
}
const at = (iso: string) => new Date(iso);

describe('failure backoff', () => {
  it('doubles from five minutes per consecutive failure and never exceeds a day', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffDelayMs(5)).toBe(16 * BACKOFF_BASE_MS);
    expect(backoffDelayMs(40)).toBe(BACKOFF_MAX_MS);
  });

  it('skips a failing source until its backoff has passed, then recovers and resets', async () => {
    const { c, state } = controllable('flaky');
    state.up = false;
    const failed = await scan(sys, c, { mode: 'broad', now: at('2026-11-12T10:00:00Z') });
    expect(failed.status).toBe('failed');
    expect(sourceGate(sys, c, at('2026-11-12T10:01:00Z'))).toMatchObject({ ok: false, failures: 1, backoffUntil: '2026-11-12T10:05:00.000Z' });

    // during backoff: skipped with the reason, and the source is not contacted
    const calls = state.healthCalls;
    const skipped = await scan(sys, c, { mode: 'broad', now: at('2026-11-12T10:02:00Z') });
    expect(skipped.status).toBe('skipped');
    expect(skipped.notes[0]).toMatch(/backing off after 1 consecutive failure/);
    expect(state.healthCalls).toBe(calls);

    // a second failure after the window doubles the wait
    await scan(sys, c, { mode: 'broad', now: at('2026-11-12T10:06:00Z') });
    expect(sourceGate(sys, c, at('2026-11-12T10:07:00Z')).backoffUntil).toBe('2026-11-12T10:16:00.000Z');

    // force overrides backoff only
    state.up = true;
    const forced = await scan(sys, c, { mode: 'broad', force: true, limit: 2, now: at('2026-11-12T10:08:00Z') });
    expect(forced.status).toBe('completed');
    expect(sourceGate(sys, c, at('2026-11-12T10:09:00Z'))).toMatchObject({ ok: true, failures: 0, backoffUntil: null });
    // newest first: scan ok, health ok, then the two failed health checks
    expect(sourceChecks(sys, 'flaky').map((x) => x.ok)).toEqual([true, true, false, false]);
  });

  it('tells a person once when a source keeps failing, not once per scan, and again after it was read and recurs', async () => {
    const { c, state } = controllable('down');
    state.up = false;
    let t = Date.parse('2026-11-12T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await scan(sys, c, { mode: 'broad', force: true, now: new Date(t) });
      t += 3_600_000;
    }
    const open = listNotifications(sys, { unreadOnly: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ level: 'warning', kind: 'source.failing', subject: 'down' });
    expect(open[0].title).toMatch(/failed 3 times in a row/);

    markNotificationsRead(sys, open[0].id);
    await scan(sys, c, { mode: 'broad', force: true, now: new Date(t) });
    expect(listNotifications(sys, { unreadOnly: true })).toHaveLength(1);

    state.up = true;
    await scan(sys, c, { mode: 'broad', force: true, limit: 1, now: new Date(t + 3_600_000) });
    expect(recentEvents(sys.db, 5, 'source.recovered')[0]).toMatchObject({ subject: 'down' });
  });
});

describe('budgets and terms', () => {
  it('enforces scans per day, requests per day and items per scan, and resets at the start of a UTC day', async () => {
    const { c, state } = controllable('metered');
    setSourceBudget(sys, 'metered', { scansPerDay: 2, maxPerScan: 3 });
    const a = await scan(sys, c, { mode: 'broad', limit: 10, now: at('2026-11-12T08:00:00Z') });
    expect(a.status).toBe('completed');
    expect(state.lastLimit).toBe(3);
    expect(a.notes).toContain('limited to 3 item(s) by the source budget');
    await scan(sys, c, { mode: 'broad', now: at('2026-11-12T09:00:00Z') });
    const third = await scan(sys, c, { mode: 'broad', now: at('2026-11-12T10:00:00Z') });
    expect(third.status).toBe('skipped');
    expect(third.notes[0]).toMatch(/daily scan budget spent \(2\/2\)/);
    expect((await scan(sys, c, { mode: 'broad', now: at('2026-11-13T00:30:00Z') })).status).toBe('completed');

    // requests: health (1) + search (3 reported) = 4 per scan
    setSourceBudget(sys, 'metered', { requestsPerDay: 6 });
    expect((await scan(sys, c, { mode: 'broad', limit: 1, now: at('2026-11-14T08:00:00Z') })).status).toBe('completed');
    expect((await scan(sys, c, { mode: 'broad', limit: 1, now: at('2026-11-14T09:00:00Z') })).status).toBe('completed');
    const over = await scan(sys, c, { mode: 'broad', now: at('2026-11-14T10:00:00Z') });
    expect(over.notes[0]).toMatch(/daily request budget spent \(8\/6\)/);
  });

  it('validates budgets', () => {
    controllable('v');
    expect(() => setSourceBudget(sys, 'v', { scansPerDay: -1 })).toThrow(/whole number/);
    expect(() => setSourceBudget(sys, 'v', { maxPerScan: 1.5 })).toThrow(/whole number/);
    expect(() => setSourceBudget(sys, 'nope', { scansPerDay: 1 })).toThrow(/Unknown source/);
    expect(setSourceBudget(sys, 'v', {})).toEqual({});
  });

  it('never contacts a source whose terms disallow automated access, even when forced', async () => {
    const { c, state } = controllable('closed', { terms: { allowed: false, basis: 'robots.txt disallows /api/' } });
    const r = await scan(sys, c, { mode: 'broad', force: true });
    expect(r.status).toBe('skipped');
    expect(r.notes[0]).toBe('not queried: robots.txt disallows /api/');
    expect(state.healthCalls + state.searchCalls).toBe(0);
  });
});

describe('enabling and disabling', () => {
  it('is stored in settings so every interface sees it, and a disabled source is not scanned', async () => {
    const { c, state } = controllable('optional');
    setSourceEnabled(sys, 'optional', false);
    expect(getSettings(sys.db).discovery.disabledSources).toContain('optional');
    expect((await scan(sys, c, { mode: 'broad' })).status).toBe('skipped');
    expect(state.healthCalls).toBe(0);
    const reg = new ConnectorRegistry().register(c);
    expect(listSources(sys, reg)[0].enabled).toBe(false);
    setSourceEnabled(sys, 'optional', true);
    expect(listSources(sys, reg)[0].enabled).toBe(true);
    expect(() => setSourceEnabled(sys, 'nope', true)).toThrow(/Unknown source/);
  });
});
