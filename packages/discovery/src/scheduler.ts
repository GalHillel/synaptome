import { type Sys, emit, notify } from '@synaptome/core';
import { type ConnectorRegistry, type ScanReport, checkUpdates, scan, sourceGate, syncSources } from './index';

/**
 * A visible, foreground scheduler. Nothing runs in the background unless a person starts `synaptome scheduler run`
 * (or registers that command with the operating system themselves). Due times are computed from the recorded scan
 * history and job events, so there is no separate scheduler state that could drift.
 */

export type Cadence = 'hourly' | 'daily' | 'weekly' | 'off';
const CADENCE_MS: Record<Cadence, number | null> = { hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000, off: null };
export const cadenceMs = (c: string) => CADENCE_MS[(c as Cadence) in CADENCE_MS ? (c as Cadence) : 'weekly'];

export interface ScheduledJob {
  id: string;
  kind: 'scan' | 'updates' | 'gaps';
  sourceId?: string;
  mode?: 'incremental' | 'broad';
  cadence: string;
  lastRun: string | null;
  nextDue: string | null;
  due: boolean;
  /** Why a due job would not run now (source terms, backoff, budget). */
  waiting?: string;
}

function lastScan(sys: Sys, sourceId: string, mode: string): string | null {
  return sys.db.get<{ t: string }>("SELECT MAX(started_at) t FROM scan_runs WHERE source_id = ? AND mode = ? AND status IN ('completed', 'failed')", sourceId, mode)?.t ?? null;
}
function lastJob(sys: Sys, jobId: string): string | null {
  // The job records the time it ran for (`payload.at`), which is the wall clock except when a time is supplied.
  return sys.db.get<{ t: string }>("SELECT MAX(COALESCE(json_extract(payload, '$.at'), ts)) t FROM events WHERE type = 'scheduler.job' AND subject = ?", jobId)?.t ?? null;
}

export function scheduleStatus(sys: Sys, reg: ConnectorRegistry, now = new Date()): ScheduledJob[] {
  syncSources(sys, reg);
  const s = sys.settings().discovery.schedule as Record<string, string>;
  const jobs: ScheduledJob[] = [];
  const add = (j: Omit<ScheduledJob, 'nextDue' | 'due'>) => {
    const every = cadenceMs(j.cadence);
    const nextDue = every == null ? null : j.lastRun ? new Date(Date.parse(j.lastRun) + every).toISOString() : now.toISOString();
    jobs.push({ ...j, nextDue, due: nextDue != null && Date.parse(nextDue) <= now.getTime() });
  };
  for (const c of reg.list()) {
    const row = sys.db.get<{ enabled: number }>('SELECT enabled FROM sources WHERE id = ?', c.id);
    // Host inventories describe this machine and are indexed on demand; blocked sources are never contacted.
    if (!row?.enabled || c.kind === 'host-inventory' || (c.terms && !c.terms.allowed)) continue;
    const gate = sourceGate(sys, c, now);
    for (const mode of ['incremental', 'broad'] as const) {
      add({ id: `scan:${c.id}:${mode}`, kind: 'scan', sourceId: c.id, mode, cadence: s[mode] ?? 'weekly', lastRun: lastScan(sys, c.id, mode), waiting: gate.ok ? undefined : gate.reason });
    }
  }
  add({ id: 'updates', kind: 'updates', cadence: s.updates ?? 'daily', lastRun: lastJob(sys, 'updates') });
  add({ id: 'gaps', kind: 'gaps', cadence: s.gaps ?? 'daily', lastRun: lastJob(sys, 'gaps') });
  return jobs;
}

/** Open gaps worth a search: seen at least `minHits` times and not searched for in the last `quietDays`. */
export function gapsToSearch(sys: Sys, now: Date, o: { minHits?: number; quietDays?: number; max?: number } = {}) {
  const since = new Date(now.getTime() - (o.quietDays ?? 7) * 86_400_000).toISOString();
  return sys.db.all<{ term: string; hits: number }>(
    `SELECT g.term, g.hits FROM gaps g WHERE g.status = 'open' AND g.hits >= ?
       AND NOT EXISTS (SELECT 1 FROM scan_runs r WHERE r.mode = 'need' AND r.query = g.term AND r.started_at >= ?)
     ORDER BY g.hits DESC, g.last_seen_at DESC LIMIT ?`,
    o.minHits ?? 2,
    since,
    o.max ?? 3,
  );
}

export interface SchedulerRun {
  at: string;
  ran: { job: string; status: string; detail: string }[];
}

/** Runs every job that is due now. Scans go through `scan()`, so terms, backoff and budgets still apply. */
export async function runDueJobs(sys: Sys, reg: ConnectorRegistry, opts: { now?: Date; limit?: number } = {}): Promise<SchedulerRun> {
  const now = opts.now ?? new Date();
  const ran: SchedulerRun['ran'] = [];
  for (const job of scheduleStatus(sys, reg, now).filter((j) => j.due)) {
    if (job.kind === 'gaps') {
      // Capability gaps that routing keeps hitting become need-driven searches, at most three gaps per pass and each
      // at most once a week, on the sources that support free-text search.
      const gaps = gapsToSearch(sys, now);
      let added = 0;
      for (const g of gaps) {
        for (const id of ['github', 'npm']) {
          try {
            const r = await scan(sys, reg.get(id), { mode: 'need', query: g.term, limit: opts.limit ?? 5, origin: 'scheduler', now });
            added += r.added;
          } catch {
            /* source not registered in this composition: skip */
          }
        }
      }
      emit(sys.db, 'scheduler.job', 'gaps', { at: now.toISOString(), gaps: gaps.map((g) => g.term), added }, 'scheduler');
      ran.push({ job: job.id, status: 'completed', detail: gaps.length ? `searched ${gaps.map((g) => `"${g.term}"`).join(', ')}: ${added} new candidate(s)` : 'no recurring gaps to search' });
      continue;
    }
    if (job.kind === 'scan') {
      const r: ScanReport = await scan(sys, reg.get(job.sourceId!), { mode: job.mode!, limit: opts.limit, origin: 'scheduler', now });
      ran.push({ job: job.id, status: r.status, detail: r.status === 'completed' ? `${r.added} new, ${r.updated} updated` : r.error ?? r.notes[0] ?? '' });
    } else {
      const results = await checkUpdates(sys, reg, opts.limit ?? 25);
      const changed = results.filter((r) => r.changed);
      for (const u of changed) {
        const cap = sys.db.get<{ id: string; status: string; installed: number }>(
          "SELECT c.id, c.status, EXISTS (SELECT 1 FROM installations i WHERE i.capability_id = c.id AND i.status = 'installed') installed FROM capabilities c WHERE c.candidate_id = ?",
          u.id,
        );
        if (cap && (cap.status === 'approved' || cap.installed)) {
          notify(sys, { level: 'action', kind: 'capability.update', subject: cap.id, title: `Update available for ${u.name}`, body: `${u.detail}. Nothing is applied automatically; review it with: synaptome update inspect ${u.id}`, dedupeKey: `update:${u.id}` });
        }
      }
      emit(sys.db, 'scheduler.job', 'updates', { at: now.toISOString(), checked: results.length, changed: changed.length }, 'scheduler');
      ran.push({ job: job.id, status: 'completed', detail: `${results.length} checked, ${changed.length} changed` });
    }
  }
  return { at: now.toISOString(), ran };
}

/**
 * Foreground loop. Checks for due jobs every `intervalMs` until `signal` aborts. Returns when stopped.
 * `onRun` receives each pass's result so the caller can print it.
 */
export async function runScheduler(sys: Sys, reg: ConnectorRegistry, opts: { intervalMs: number; signal: AbortSignal; onRun?: (r: SchedulerRun) => void; limit?: number }) {
  while (!opts.signal.aborted) {
    opts.onRun?.(await runDueJobs(sys, reg, { limit: opts.limit }));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.intervalMs);
      opts.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
