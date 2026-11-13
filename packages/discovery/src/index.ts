import {
  type CandidateDraft, type CandidateRow, type DiscoveryConnector, type Settings, type Sys,
  emit, getCandidate, j, jaccard, mapCandidate, notify, nowIso, pj, shortHash, tokenize,
} from '@synaptome/core';
import { recordSourceOutcome, sourceGate } from './sources';

export * from './sources';
export * from './scheduler';

/* =====================================================================
 * Connector registry. The engine only knows the DiscoveryConnector
 * contract; concrete connectors are supplied by the composition root.
 * ===================================================================== */

export class ConnectorRegistry {
  private map = new Map<string, DiscoveryConnector>();
  register(c: DiscoveryConnector): this {
    if (this.map.has(c.id)) throw new Error(`Connector already registered: ${c.id}`);
    this.map.set(c.id, c);
    return this;
  }
  get(id: string): DiscoveryConnector {
    const c = this.map.get(id);
    if (!c) throw new Error(`Unknown source "${id}". Known: ${[...this.map.keys()].join(', ')}`);
    return c;
  }
  list(): DiscoveryConnector[] {
    return [...this.map.values()];
  }
}

/** Mirrors registered connectors into the `sources` table (state survives restarts). */
export function syncSources(sys: Sys, reg: ConnectorRegistry) {
  const disabled = new Set(sys.settings().discovery.disabledSources);
  for (const c of reg.list()) {
    sys.db.run(
      `INSERT INTO sources (id, kind, title, official, enabled, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, official=excluded.official, enabled=excluded.enabled`,
      c.id, c.kind, c.title, c.official, !disabled.has(c.id), nowIso(),
    );
  }
}

export interface SourceInfo {
  id: string;
  kind: string;
  title: string;
  description: string;
  official: boolean;
  enabled: boolean;
  health: string;
  healthDetail: string | null;
  rate: any;
  lastScanAt: string | null;
  lastOkAt: string | null;
  candidates: number;
}
export function listSources(sys: Sys, reg: ConnectorRegistry): SourceInfo[] {
  syncSources(sys, reg);
  return reg.list().map((c) => {
    const r = sys.db.get<any>('SELECT * FROM sources WHERE id=?', c.id)!;
    return {
      id: c.id, kind: c.kind, title: c.title, description: c.description, official: c.official, enabled: !!r.enabled, health: r.health,
      healthDetail: r.health_detail, rate: pj(r.rate, null), lastScanAt: r.last_scan_at, lastOkAt: r.last_ok_at,
      candidates: sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM candidates WHERE source_id=?', c.id)!.n,
    };
  });
}

export async function checkSourceHealth(sys: Sys, c: DiscoveryConnector, opts: { now?: Date } = {}) {
  // A source whose terms disallow automated access is never contacted, not even for a health check.
  if (c.terms && !c.terms.allowed) {
    sys.db.run("UPDATE sources SET health='blocked', health_detail=?, terms=? WHERE id=?", `not queried: ${c.terms.basis}`, j(c.terms), c.id);
    return { id: c.id, ok: false, authenticated: false, detail: `not queried: ${c.terms.basis}`, health: 'blocked' };
  }
  let h: Awaited<ReturnType<DiscoveryConnector['health']>>;
  const t0 = performance.now();
  try {
    h = await c.health();
  } catch (e: any) {
    h = { ok: false, detail: e?.message ?? String(e), authenticated: false };
  }
  const latencyMs = Math.round(performance.now() - t0);
  const prev = sys.db.get<{ health: string }>('SELECT health FROM sources WHERE id=?', c.id)?.health;
  const health = h.ok ? 'healthy' : 'unavailable';
  sys.db.run('UPDATE sources SET health=?, health_detail=?, rate=?, terms=? WHERE id=?', health, h.detail, j(h.rate), c.terms ? j(c.terms) : null, c.id);
  recordSourceOutcome(sys, c.id, { ok: h.ok, detail: `health: ${h.detail}`, latencyMs, requests: 1, now: opts.now });
  if (prev !== health) emit(sys.db, 'source.health', c.id, { health, detail: h.detail });
  return { id: c.id, ...h, health, latencyMs };
}

/* =====================================================================
 * Ranking. A transparent triage order for the evaluation queue — NOT a
 * quality score. Quality is only assigned after audit (acquisition).
 * ===================================================================== */

export function rankDraft(d: CandidateDraft, ctx: { official: boolean; settings: Settings; query?: string }): { rank: number; reasons: string[] } {
  let rank = 30;
  const reasons: string[] = [];
  const add = (n: number, why: string) => {
    rank += n;
    reasons.push(`${n >= 0 ? '+' : ''}${n} ${why}`);
  };
  const pol = ctx.settings.policy;
  if (d.publisher && pol.officialPublishers.includes(d.publisher.toLowerCase())) add(22, `official publisher ${d.publisher}`);
  else if (ctx.official) add(8, 'listed by an official registry');
  if (d.publisher && pol.denyPublishers.includes(d.publisher.toLowerCase())) add(-60, 'publisher on deny list');

  if (!d.licenseSpdx || d.licenseSpdx === 'NOASSERTION') add(-6, 'licence not stated by source');
  else if (pol.allowedLicenses.includes(d.licenseSpdx)) add(12, `licence ${d.licenseSpdx}`);
  else add(-18, `licence ${d.licenseSpdx} not on allow list`);

  const pop = Number(d.stars ?? 0);
  if (pop > 0) add(Math.min(14, Math.round(Math.log10(pop + 1) * 3.5)), `popularity signal ${pop} (weak evidence)`);

  if (d.pushedAt) {
    const days = (Date.now() - Date.parse(d.pushedAt)) / 864e5;
    if (days <= 120) add(8, 'updated within 120 days');
    else if (days > 730) add(-8, 'no update for over two years');
  }
  if ((d.description ?? '').trim().length >= 40) add(5, 'has a substantive description');
  else add(-4, 'thin or missing description');

  if (ctx.query) {
    const q = tokenize(ctx.query);
    const hay = tokenize(`${d.name} ${d.description} ${(d.topics ?? []).join(' ')}`);
    const hit = q.filter((t) => hay.some((h) => h.startsWith(t) || t.startsWith(h))).length;
    if (q.length) add(Math.round((hit / q.length) * 14), `matches ${hit}/${q.length} query terms`);
  }
  const pref = ctx.settings.discovery;
  const topics = (d.topics ?? []).map((t) => t.toLowerCase());
  if (pref.excludedCategories.some((c) => topics.includes(c.toLowerCase()))) add(-40, 'excluded category');
  if (pref.preferredCategories.some((c) => topics.includes(c.toLowerCase()))) add(6, 'preferred category');
  return { rank: Math.max(0, Math.min(100, rank)), reasons };
}

/* ---------- duplicate and overlap detection (flags only; never merges) ---------- */

export function findOverlap(sys: Sys, self: { id: string; name: string; description: string; kind: string; repo?: string | null; path?: string | null; sourceId: string }) {
  const out: { id: string; name: string; similarity: number; basis: string }[] = [];
  let duplicateOf: string | null = null;
  const mine = tokenize(`${self.name.replace(/[-_]/g, ' ')} ${self.description}`);
  const nameToks = tokenize(self.name.replace(/[-_/]/g, ' '));
  const rows = sys.db.all<any>('SELECT id, name, description, kind, repo, path, source_id, first_seen_at FROM candidates WHERE id != ? AND kind = ?', self.id, self.kind);
  for (const r of rows) {
    if (self.repo && r.repo && self.repo.toLowerCase() === String(r.repo).toLowerCase() && (self.path ?? '') === (r.path ?? '')) {
      duplicateOf ??= r.id;
      out.push({ id: r.id, name: r.name, similarity: 1, basis: `same repository and path via ${r.source_id}` });
      continue;
    }
    const sim = jaccard(mine, tokenize(`${String(r.name).replace(/[-_]/g, ' ')} ${r.description}`));
    const nameSim = jaccard(nameToks, tokenize(String(r.name).replace(/[-_/]/g, ' ')));
    if (nameSim >= 0.99 && nameToks.length) out.push({ id: r.id, name: r.name, similarity: Math.max(sim, 0.7), basis: 'identical name, different origin' });
    else if (sim >= 0.5) out.push({ id: r.id, name: r.name, similarity: Number(sim.toFixed(2)), basis: 'similar name and description (possible functional overlap)' });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return { duplicateOf, overlap: out.slice(0, 8) };
}

/* =====================================================================
 * Scan engine
 * ===================================================================== */

export interface ScanOptions {
  mode: 'broad' | 'incremental' | 'need';
  query?: string;
  limit?: number;
  origin?: string;
  /** Run even while the source is backing off after failures (terms and budgets still apply). */
  force?: boolean;
  /** Current time, for tests. */
  now?: Date;
}
export interface ScanReport {
  scanId: number;
  sourceId: string;
  mode: string;
  query: string | null;
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  found: number;
  added: number;
  updated: number;
  unchanged: number;
  queued: number;
  notes: string[];
  error?: string;
  candidateIds: string[];
}

const candidateId = (sourceId: string, externalId: string) => `c-${shortHash(`${sourceId}\n${externalId}`, 12)}`;

export async function scan(sys: Sys, c: DiscoveryConnector, opts: ScanOptions): Promise<ScanReport> {
  const settings = sys.settings();
  const src = sys.db.get<any>('SELECT * FROM sources WHERE id=?', c.id);
  if (!src) throw new Error(`Source ${c.id} is not registered; call syncSources first`);
  const started = opts.now ? opts.now.toISOString() : nowIso();
  const scanId = Number(
    sys.db.run('INSERT INTO scan_runs (source_id, mode, query, origin, started_at, status) VALUES (?,?,?,?,?,?)', c.id, opts.mode, opts.query ?? null, opts.origin ?? 'cli', started, 'running').lastInsertRowid,
  );
  const report: ScanReport = { scanId, sourceId: c.id, mode: opts.mode, query: opts.query ?? null, status: 'completed', found: 0, added: 0, updated: 0, unchanged: 0, queued: 0, notes: [], candidateIds: [] };
  const finish = (status: ScanReport['status'], error?: string, rate?: unknown) => {
    report.status = status;
    report.error = error;
    sys.db.run('UPDATE scan_runs SET finished_at=?, status=?, found=?, added=?, updated=?, unchanged=?, error=?, notes=?, rate=? WHERE id=?', nowIso(), status, report.found, report.added, report.updated, report.unchanged, error ?? null, j(report.notes), j(rate), scanId);
    sys.db.run('UPDATE sources SET last_scan_at=? WHERE id=?', nowIso(), c.id);
    emit(sys.db, `scan.${status}`, c.id, { scanId, mode: opts.mode, query: opts.query, found: report.found, added: report.added, updated: report.updated, error }, opts.origin);
    return report;
  };
  if (!src.enabled) {
    report.notes.push('source disabled in settings');
    return finish('skipped');
  }
  // Terms, backoff and budgets are checked before any request is made.
  const gate = sourceGate(sys, c, opts.now);
  const backingOffOnly = !gate.ok && gate.reason?.startsWith('backing off');
  if (!gate.ok && !(backingOffOnly && opts.force)) {
    report.notes.push(gate.reason!);
    return finish('skipped');
  }
  emit(sys.db, 'scan.started', c.id, { scanId, mode: opts.mode, query: opts.query }, opts.origin);

  const health = await checkSourceHealth(sys, c, { now: opts.now });
  if (!health.ok) return finish('failed', `source unavailable: ${health.detail}`);

  const cap = gate.budget.maxPerScan;
  const limit = Math.min(opts.limit ?? settings.discovery.maxPerQuery, cap ?? Number.POSITIVE_INFINITY);
  if (cap != null && (opts.limit ?? settings.discovery.maxPerQuery) > cap) report.notes.push(`limited to ${cap} item(s) by the source budget`);
  let result;
  const t0 = performance.now();
  try {
    result = await c.search({ mode: opts.mode, query: opts.query, limit, cursor: pj(src.cursor, undefined) });
  } catch (e: any) {
    sys.db.run("UPDATE sources SET health='degraded', health_detail=? WHERE id=?", e?.message ?? String(e), c.id);
    recordSourceOutcome(sys, c.id, { ok: false, detail: `scan: ${e?.message ?? String(e)}`, latencyMs: Math.round(performance.now() - t0), now: opts.now });
    return finish('failed', e?.message ?? String(e));
  }
  recordSourceOutcome(sys, c.id, { ok: true, detail: `scan: ${result.drafts.length} item(s)`, latencyMs: Math.round(performance.now() - t0), requests: result.requests ?? 0, now: opts.now });
  report.notes.push(...(result.notes ?? []));
  report.found = result.drafts.length;

  for (const d of result.drafts) {
    const id = candidateId(c.id, d.externalId);
    const now = nowIso();
    const existing = sys.db.get<any>('SELECT * FROM candidates WHERE id=?', id);
    const { rank, reasons } = rankDraft(d, { official: c.official, settings, query: opts.query });
    if (!existing) {
      sys.db.run(
        `INSERT INTO candidates (id, source_id, external_id, kind, name, description, url, repo, ref, path, publisher, license_spdx, license_evidence, stars, pushed_at,
          topics, upstream_version, signals, raw, state, rank, rank_reasons, first_seen_at, last_seen_at, first_scan_id, last_scan_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, c.id, d.externalId, d.kind, d.name, d.description ?? '', d.url ?? null, d.repo ?? null, d.ref ?? null, d.path ?? null, d.publisher ?? null,
        d.licenseSpdx ?? null, d.licenseEvidence ?? null, d.stars ?? null, d.pushedAt ?? null, j(d.topics ?? []), d.upstreamVersion ?? null, j(d.signals ?? {}),
        j(d.raw ?? null), 'discovered', rank, j(reasons), now, now, scanId, scanId,
      );
      const { duplicateOf, overlap } = findOverlap(sys, { id, name: d.name, description: d.description ?? '', kind: d.kind, repo: d.repo, path: d.path, sourceId: c.id });
      const finalRank = duplicateOf ? Math.max(0, rank - 30) : rank;
      // Host inventories describe what is already installed; they are indexed, never queued for acquisition.
      const action = c.kind === 'host-inventory' ? 'inventory' : recommend({ rank: finalRank, duplicateOf, licenseSpdx: d.licenseSpdx, settings });
      const state = action === 'evaluate' ? 'queued' : 'discovered';
      sys.db.run('UPDATE candidates SET duplicate_of=?, overlap=?, rank=?, rank_reasons=?, recommended_action=?, state=? WHERE id=?', duplicateOf, j(overlap), finalRank, j(duplicateOf ? [...reasons, '-30 duplicate of an already discovered candidate'] : reasons), action, state, id);
      if (state === 'queued') report.queued++;
      report.added++;
      emit(sys.db, 'candidate.discovered', id, { name: d.name, kind: d.kind, source: c.id, rank: finalRank, action }, opts.origin);
    } else {
      // Prefer the content-addressed upstream version (e.g. a git tree sha); fall back to the ref.
      const changed = d.upstreamVersion && existing.upstream_version ? d.upstreamVersion !== existing.upstream_version : !!(d.ref && existing.ref && d.ref !== existing.ref);
      // A changed upstream never overwrites what was audited: it only raises update_available.
      const audited = ['audited', 'registered', 'blocked', 'rejected', 'quarantined'].includes(existing.state);
      sys.db.run(
        `UPDATE candidates SET last_seen_at=?, last_scan_id=?, stars=?, pushed_at=?, signals=?, description=CASE WHEN description='' THEN ? ELSE description END,
           update_available=CASE WHEN ? THEN 1 ELSE update_available END, ref=CASE WHEN ? THEN ref ELSE COALESCE(?, ref) END,
           upstream_version=CASE WHEN ? THEN upstream_version ELSE COALESCE(?, upstream_version) END WHERE id=?`,
        now, scanId, d.stars ?? existing.stars, d.pushedAt ?? existing.pushed_at, j({ ...pj(existing.signals, {}), ...(d.signals ?? {}), ...(changed && audited ? { upstreamRef: d.ref ?? '', upstreamVersionSeen: d.upstreamVersion ?? '' } : {}) }),
        d.description ?? '', changed && audited, audited, d.ref ?? null, audited, d.upstreamVersion ?? null, id,
      );
      if (changed) {
        report.updated++;
        emit(sys.db, 'candidate.update-detected', id, { name: existing.name, from: existing.ref ?? existing.upstream_version, to: d.ref ?? d.upstreamVersion }, opts.origin);
      } else report.unchanged++;
    }
    report.candidateIds.push(id);
  }
  if (result.cursor !== undefined) sys.db.run('UPDATE sources SET cursor=? WHERE id=?', j(result.cursor), c.id);
  if (result.rate) sys.db.run('UPDATE sources SET rate=? WHERE id=?', j(result.rate), c.id);
  // A search that stopped early (e.g. at a rate limit) kept what it found, but is not reported as complete.
  return finish(result.stoppedEarly ? 'partial' : 'completed', result.stoppedEarly, result.rate);
}

export function recommend(x: { rank: number; duplicateOf: string | null; licenseSpdx?: string | null; settings: Settings }): string {
  if (x.duplicateOf) return 'skip-duplicate';
  if (x.licenseSpdx && x.licenseSpdx !== 'NOASSERTION' && !x.settings.policy.allowedLicenses.includes(x.licenseSpdx)) return 'review-license';
  if (x.rank >= 50) return 'evaluate';
  return 'low-priority';
}

/** Runs one mode across every enabled source, sequentially (keeps API budgets predictable). */
export async function scanAll(sys: Sys, reg: ConnectorRegistry, opts: ScanOptions & { sources?: string[] }): Promise<ScanReport[]> {
  syncSources(sys, reg);
  const out: ScanReport[] = [];
  for (const c of reg.list()) {
    if (opts.sources?.length && !opts.sources.includes(c.id)) continue;
    out.push(await scan(sys, c, opts));
  }
  return out;
}

/** Update detection for candidates that were already acquired, via the connector's checkUpdate. */
export async function checkUpdates(sys: Sys, reg: ConnectorRegistry, limit = 25): Promise<{ id: string; name: string; changed: boolean; detail: string }[]> {
  const rows = sys.db.all<any>("SELECT * FROM candidates WHERE state IN ('registered','audited') ORDER BY last_seen_at ASC LIMIT ?", limit);
  const out: { id: string; name: string; changed: boolean; detail: string }[] = [];
  for (const r of rows) {
    const cand = mapCandidate(r);
    let c: DiscoveryConnector;
    try {
      c = reg.get(cand.sourceId);
    } catch {
      continue;
    }
    if (!c.checkUpdate) {
      out.push({ id: cand.id, name: cand.name, changed: false, detail: 'source does not support update checks' });
      continue;
    }
    try {
      const u = await c.checkUpdate({ externalId: cand.externalId, repo: cand.repo, ref: cand.ref, path: cand.path, upstreamVersion: cand.upstreamVersion, raw: cand.raw });
      // A new owner is a supply-chain event in its own right, even when the content did not change.
      const differs = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() !== b.toLowerCase();
      const moved = differs(u.publisher, cand.publisher) || differs(u.repo, cand.repo);
      const publisherChange = moved ? { from: { publisher: cand.publisher, repo: cand.repo }, to: { publisher: u.publisher ?? cand.publisher, repo: u.repo ?? cand.repo }, detectedAt: nowIso() } : cand.signals.publisherChange;
      const changed = u.changed || moved;
      sys.db.run('UPDATE candidates SET update_available=?, signals=?, last_seen_at=? WHERE id=?', changed, j({ ...cand.signals, upstreamRef: u.ref ?? '', upstreamVersionSeen: u.version ?? '', ...(publisherChange ? { publisherChange } : {}) }), nowIso(), cand.id);
      if (changed) emit(sys.db, 'candidate.update-detected', cand.id, { name: cand.name, from: cand.ref ?? cand.upstreamVersion, to: u.ref ?? u.version, publisherChange: moved ? publisherChange : null });
      if (moved) {
        notify(sys, {
          level: 'warning',
          kind: 'capability.publisher-change',
          subject: cand.capabilityId ?? cand.id,
          title: `Publisher changed: ${cand.name}`,
          body: `${cand.repo ?? cand.publisher} is now ${u.repo ?? u.publisher}. The next version needs a person's approval before it is installed.`,
          dedupeKey: `publisher-change:${cand.id}:${u.repo ?? u.publisher}`,
        });
      }
      out.push({ id: cand.id, name: cand.name, changed, detail: moved ? `publisher changed: ${cand.repo ?? cand.publisher} -> ${u.repo ?? u.publisher}` : u.detail ?? (u.changed ? `upstream moved to ${u.ref ?? u.version}` : 'up to date') });
    } catch (e: any) {
      out.push({ id: cand.id, name: cand.name, changed: false, detail: `check failed: ${e?.message ?? e}` });
    }
  }
  return out;
}

export function evaluationQueue(sys: Sys, limit = 20): CandidateRow[] {
  return sys.db.all<any>("SELECT * FROM candidates WHERE state='queued' ORDER BY rank DESC, first_seen_at ASC LIMIT ?", limit).map(mapCandidate);
}

export function scanHistory(sys: Sys, limit = 30) {
  return sys.db.all<any>('SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ...r, notes: pj(r.notes, []), rate: pj(r.rate, null) }));
}

export { getCandidate };

/* ---------- scheduling (visible OS tasks; never registered silently) ---------- */

/**
 * What would be registered with the operating system if the owner chooses to: one hourly task that runs the
 * scheduler once. The scheduler then decides what is due from `discovery.schedule`, so cadence, terms, backoff and
 * budgets apply exactly as when it runs in the foreground. Nothing is registered without explicit confirmation.
 */
export function schedulePlan(binCommand: string, _settings: Settings) {
  const t = { name: 'Synaptome Scheduler', schedule: 'hourly', args: 'scheduler run --once' };
  return [
    {
      ...t,
      windows: { create: `schtasks /Create /TN "${t.name}" /SC HOURLY /TR "${binCommand} ${t.args}" /F`, remove: `schtasks /Delete /TN "${t.name}" /F`, query: `schtasks /Query /TN "${t.name}"` },
      cron: `0 * * * * ${binCommand} ${t.args}`,
    },
  ];
}
