import { type DiscoveryConnector, type SourceTerms, type Sys, emit, getSettings, j, notify, pj, setSetting } from '@synaptome/core';

/**
 * Source management: health history, failure backoff, request budgets and access terms.
 * Every function takes the current time explicitly (default: now) so behaviour over time is testable.
 */

export interface SourceBudget {
  /** Scans per UTC day. */
  scansPerDay?: number;
  /** HTTP requests per UTC day, counted from what connectors report. */
  requestsPerDay?: number;
  /** Upper bound on candidates requested in one scan. */
  maxPerScan?: number;
}

/** First retry after 5 minutes, doubling per consecutive failure, never more than a day. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 24 * 3_600_000;
/** Consecutive failures after which a person is told. */
export const FAILURE_NOTICE_AT = 3;

const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

/** Records one health check or scan outcome; maintains the failure count, backoff and notifications. */
export function recordSourceOutcome(sys: Sys, sourceId: string, o: { ok: boolean; detail?: string; latencyMs?: number; requests?: number; now?: Date }) {
  const now = o.now ?? new Date();
  const at = now.toISOString();
  sys.db.run('INSERT INTO source_checks (source_id, at, ok, detail, latency_ms, requests) VALUES (?,?,?,?,?,?)', sourceId, at, o.ok, o.detail ?? null, o.latencyMs ?? null, o.requests ?? 0);
  if (o.ok) {
    const prev = sys.db.get<{ failures: number }>('SELECT failures FROM sources WHERE id = ?', sourceId)?.failures ?? 0;
    sys.db.run('UPDATE sources SET failures = 0, backoff_until = NULL, last_ok_at = ? WHERE id = ?', at, sourceId);
    if (prev >= FAILURE_NOTICE_AT) emit(sys.db, 'source.recovered', sourceId, { after: prev });
    return { failures: 0, backoffUntil: null as string | null };
  }
  const failures = (sys.db.get<{ failures: number }>('SELECT failures FROM sources WHERE id = ?', sourceId)?.failures ?? 0) + 1;
  const backoffUntil = new Date(now.getTime() + backoffDelayMs(failures)).toISOString();
  sys.db.run('UPDATE sources SET failures = ?, backoff_until = ? WHERE id = ?', failures, backoffUntil, sourceId);
  if (failures >= FAILURE_NOTICE_AT) {
    notify(sys, { level: 'warning', kind: 'source.failing', subject: sourceId, title: `${sourceId} has failed ${failures} times in a row`, body: `Last error: ${o.detail ?? 'unknown'}. Synaptome retries after ${backoffUntil}.`, dedupeKey: `source-failing:${sourceId}` });
  }
  return { failures, backoffUntil };
}

export interface SourceGate {
  ok: boolean;
  reason?: string;
  failures: number;
  backoffUntil: string | null;
  terms: SourceTerms | null;
  budget: SourceBudget;
  today: { scans: number; requests: number };
}

/** Whether a scan may run now, and if not, why. Disabled sources are handled by the caller. */
export function sourceGate(sys: Sys, c: Pick<DiscoveryConnector, 'id' | 'terms'>, now = new Date()): SourceGate {
  const row = sys.db.get<any>('SELECT failures, backoff_until, budget, terms FROM sources WHERE id = ?', c.id) ?? {};
  const terms: SourceTerms | null = c.terms ?? pj(row.terms, null);
  const budget: SourceBudget = pj(row.budget, {}) ?? {};
  const since = dayStart(now);
  const today = {
    scans: sys.db.get<{ n: number }>("SELECT COUNT(*) n FROM scan_runs WHERE source_id = ? AND started_at >= ? AND status NOT IN ('skipped', 'running')", c.id, since)!.n,
    requests: sys.db.get<{ n: number }>('SELECT COALESCE(SUM(requests), 0) n FROM source_checks WHERE source_id = ? AND at >= ?', c.id, since)!.n,
  };
  const base = { failures: row.failures ?? 0, backoffUntil: row.backoff_until ?? null, terms, budget, today };
  if (terms && !terms.allowed) return { ...base, ok: false, reason: `not queried: ${terms.basis}` };
  if (row.backoff_until && Date.parse(row.backoff_until) > now.getTime()) return { ...base, ok: false, reason: `backing off after ${row.failures} consecutive failure(s) until ${row.backoff_until}` };
  if (budget.scansPerDay != null && today.scans >= budget.scansPerDay) return { ...base, ok: false, reason: `daily scan budget spent (${today.scans}/${budget.scansPerDay})` };
  if (budget.requestsPerDay != null && today.requests >= budget.requestsPerDay) return { ...base, ok: false, reason: `daily request budget spent (${today.requests}/${budget.requestsPerDay})` };
  return { ...base, ok: true };
}

export function setSourceBudget(sys: Sys, sourceId: string, budget: SourceBudget) {
  for (const [k, v] of Object.entries(budget)) if (v != null && (!Number.isInteger(v) || v < 0)) throw new Error(`Budget ${k} must be a whole number of 0 or more`);
  if (!sys.db.get('SELECT 1 FROM sources WHERE id = ?', sourceId)) throw new Error(`Unknown source "${sourceId}"`);
  const clean = Object.fromEntries(Object.entries(budget).filter(([, v]) => v != null));
  sys.db.run('UPDATE sources SET budget = ? WHERE id = ?', Object.keys(clean).length ? j(clean) : null, sourceId);
  emit(sys.db, 'source.budget', sourceId, clean);
  return clean;
}

/** Enables or disables a source. Stored in settings, so every interface sees the same state. */
export function setSourceEnabled(sys: Sys, sourceId: string, enabled: boolean) {
  if (!sys.db.get('SELECT 1 FROM sources WHERE id = ?', sourceId)) throw new Error(`Unknown source "${sourceId}"`);
  const disabled = new Set(getSettings(sys.db).discovery.disabledSources);
  if (enabled) disabled.delete(sourceId);
  else disabled.add(sourceId);
  setSetting(sys.db, 'discovery.disabledSources', [...disabled]);
  sys.db.run('UPDATE sources SET enabled = ? WHERE id = ?', enabled, sourceId);
  emit(sys.db, enabled ? 'source.enabled' : 'source.disabled', sourceId, {});
}

/** Recent outcomes for one source, newest first. */
export function sourceChecks(sys: Sys, sourceId: string, limit = 20) {
  return sys.db.all<any>('SELECT * FROM source_checks WHERE source_id = ? ORDER BY id DESC LIMIT ?', sourceId, limit).map((r) => ({ at: r.at, ok: !!r.ok, detail: r.detail, latencyMs: r.latency_ms, requests: r.requests }));
}
