import { readCapabilityEntry } from '@synaptome/acquisition';
import { evidenceStrategy } from './v2';

export * from './v2';
export * from './benchmark/run';
export { BENCH_TASKS, type BenchTask, isHeldOut } from './benchmark/tasks';
export { BENCH_CAPABILITIES } from './benchmark/registry';
import {
  type CapabilityRow, type RouteDecision, type RouteSelection, type RoutingStrategy, type Sys, type TaskAnalysis, type WorkflowExecutor,
  STAGE_ORDER, domainById, emit, getCapability, j, listCapabilities, nowIso, pj, scoreDomains, tokenize,
} from '@synaptome/core';

/* =====================================================================
 * Task understanding (deterministic; no model call)
 * ===================================================================== */

const SCOPE_WORDS = /\b(production|production-quality|complete|full|entire|end-to-end|sophisticated|advanced|platform|saas|application|system|from scratch|comprehensive)\b/gi;
const SMALL_VERBS = /^\s*(fix|rename|typo|change|update|bump|tweak|remove|delete|add (a|an|one)|what|why|how|explain|show|list|check)\b/i;
const SENSITIVE = /\b(credential|password|secret|token|api key|payment|billing|pii|personal data|production database|auth|encryption|medical|financial)\b/i;

export function analyzeTask(task: string): TaskAnalysis {
  const terms = tokenize(task);
  const words = task.trim().split(/\s+/).filter(Boolean).length;
  const all = scoreDomains(task);
  const scope = (task.match(SCOPE_WORDS) ?? []).length;
  const nd = all.length;
  let complexity: TaskAnalysis['complexity'];
  if ((scope >= 2 && nd >= 3) || nd >= 6) complexity = 'large';
  else if (nd >= 4 || (scope >= 1 && nd >= 2 && words > 12)) complexity = 'medium';
  else if (words <= 4 || (words <= 16 && nd <= 2 && SMALL_VERBS.test(task) && scope === 0)) complexity = 'trivial';
  else complexity = 'small';
  const keep = { trivial: 1, small: 2, medium: 4, large: 6 }[complexity];
  const domains = all.slice(0, keep);
  const stages = [...new Set(domains.map((d) => domainById(d.id)?.stage ?? 'build'))].sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
  return { task, terms, domains, complexity, sensitivity: SENSITIVE.test(task) ? 'elevated' : 'normal', stages };
}

/* =====================================================================
 * Retrieval + selection
 * ===================================================================== */

const MAX_CAPS = { trivial: 1, small: 2, medium: 4, large: 7 } as const;
const CONTEXT_BUDGET = 15000; // estimated tokens across everything a route may activate
const VERIFY: Record<string, string> = {
  research: 'claims are sourced and cross-checked',
  design: 'design is reviewed against the stated requirements',
  build: 'it builds and runs; tests cover the new behaviour',
  verify: 'tests, security checks and accessibility checks pass',
  ship: 'deployment is verified and the rollback path is known',
  document: 'documentation matches actual behaviour',
};

/** Words that describe ambition rather than subject; they carry no routing signal. */
const GENERIC = new Set(
  'production quality advanced sophisticated complete full simple good best great high premium modern professional application applications app apps project projects system systems feature features code update updates based including team work task tasks thing things level version versions support ensure improve improved better proper properly correct correctly existing current'.split(' '),
);
/** Domain keywords too common to justify pulling in a capability on their own (they still count alongside stronger ones). */
const WEAK = new Set(
  'fix product service optimize optimization web interactive data model guide report review index query server node component components slow memory cache caching write writing copy article verify sources market customer strategy growth spec bot pr git ci cd go design layout visual color analysis analyze skill skills prompt prompts auth dashboard chart charts summary status email integration schedule bug failing test tests schema'.split(' '),
);
/** Same word, or the same stem with a short inflection (test/tests/testing), never a loose prefix (config/configurator). */
const near = (a: string, b: string) => a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 3);
const hits = (needles: string[], hay: string[]) => needles.filter((n) => hay.some((h) => near(h, n)));

export function baseEligibility(c: CapabilityRow): { ok: boolean; reason: string } {
  if (c.status === 'blocked') return { ok: false, reason: 'blocked by the security audit' };
  if (c.status === 'rejected') return { ok: false, reason: 'rejected' };
  if (c.status === 'deprecated') return { ok: false, reason: 'deprecated' };
  if (c.status === 'approved') return { ok: true, reason: 'approved' };
  if (c.origin === 'host-inventory') return { ok: true, reason: 'already installed on this host' };
  return { ok: false, reason: 'registered but not approved yet' };
}

/**
 * `assumeEligible` lets the Skill Forge test how an unapproved candidate WOULD route (activation tests)
 * without approving it. It is never set on a routing path that serves content.
 */
export function lexicalGraphStrategy(sys: Sys, cfg: { assumeEligible?: Set<string> } = {}): RoutingStrategy {
  const eligibility = (c: CapabilityRow) => (cfg.assumeEligible?.has(c.id) ? { ok: true, reason: 'candidate under activation test' } : baseEligibility(c));
  return {
    id: 'lexical-graph-v1',
    route(task, opts = {}) {
      const analysis = analyzeTask(task);
      const max = Math.min(opts.max ?? 99, MAX_CAPS[analysis.complexity]);
      const selected: (RouteSelection & { cost: number; domain: string })[] = [];
      const excluded: RouteDecision['excluded'] = [];
      const gaps: RouteDecision['gaps'] = [];
      const seenExcluded = new Set<string>();
      const overlapOf = (id: string) => new Set(sys.db.all<{ src: string; dst: string }>("SELECT src, dst FROM relations WHERE rel='overlaps' AND (src=? OR dst=?)", id, id).flatMap((r) => [r.src, r.dst]));

      const specific = analysis.terms.filter((t) => !GENERIC.has(t));
      const total = sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM capabilities')!.n;
      const idfCache = new Map<string, number>();
      /** Inverse document frequency of a keyword across capability names, descriptions and tags. */
      const idf = (k: string) => {
        if (!idfCache.has(k)) {
          const df = sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM capabilities_fts WHERE capabilities_fts MATCH ?', `{name description tags} : "${k.replace(/"/g, '')}"*`)?.n ?? 0;
          idfCache.set(k, Math.log(1 + total / (1 + df)));
        }
        return idfCache.get(k)!;
      };
      // Pass 0 is domain-agnostic: a capability whose own description covers several distinctive task terms.
      // Then one pass per recognised domain.
      const passes = [
        ...(specific.length >= 3 ? [{ id: '*', title: 'Direct match', matched: specific, score: 0, direct: true }] : []),
        ...analysis.domains.map((x) => ({ id: x.id, title: domainById(x.id)!.title, matched: x.matched, score: x.score, direct: false })),
      ];
      for (const d of passes) {
        if (selected.length >= max) break;
        if (!d.direct && selected.some((s) => s.domain === d.id)) continue; // already covered
        if (!d.direct && d.matched.every((k) => WEAK.has(k))) continue; // only weak signals: not worth a capability
        // Domain passes search on the domain's own keywords so one loud domain cannot crowd out the others.
        const rows = listCapabilities(sys, { q: d.matched.join(' '), limit: 40 }).items;
        const weights = d.matched.map((k) => idf(k));
        const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
        const top = rows[0]?.score || 1;
        const scored = rows
          .map((c) => {
            const hay = tokenize(`${c.name.replace(/[-_]/g, ' ')} ${c.description} ${c.tags.join(' ')}`);
            const domainHits = hits(d.matched, hay);
            const termHits = hits(specific, hay);
            const installed = c.installedHosts.length > 0;
            // Coverage is rarity-weighted: matching "webgl" counts for more than matching "interactive".
            const coverage = d.matched.reduce((n, k, i) => n + (domainHits.includes(k) ? weights[i] : 0), 0) / weightSum;
            const score = 0.45 * ((c.score ?? 0) / top) + (c.domain === d.id ? 0.15 : 0) + coverage * 0.17 + (Math.min(termHits.length, 4) / 4) * 0.08 + ((c.quality ?? 50) / 100) * 0.1 + (installed ? 0.03 : 0) + (c.trust === 'OFFICIAL_VERIFIED' ? 0.05 : 0) - (c.contextCost > 6000 ? 0.05 : 0);
            // Direct: at least three distinctive terms and 40% of them. Domain: the distinctive part of the
            // domain's keywords must be covered, plus the capability's own domain or two independent hits.
            const relevant = d.direct
              ? termHits.length >= 3 && termHits.length / specific.length >= 0.4
              : coverage >= 0.34 && domainHits.some((k) => !WEAK.has(k));
            return { c, score, domainHits, termHits, installed, relevant, elig: eligibility(c) };
          })
          .filter((x) => x.relevant)
          .sort((a, b) => b.score - a.score);

        let winner: (typeof scored)[number] | undefined;
        for (const x of scored) {
          if (selected.some((s) => s.capabilityId === x.c.id)) continue;
          if (!x.elig.ok) {
            if (!seenExcluded.has(x.c.id) && excluded.length < 10) excluded.push({ capabilityId: x.c.id, name: x.c.name, reason: x.elig.reason }), seenExcluded.add(x.c.id);
            continue;
          }
          const clash = selected.find((s) => s.name === x.c.name || overlapOf(x.c.id).has(s.capabilityId));
          if (clash) {
            if (!seenExcluded.has(x.c.id) && excluded.length < 10) excluded.push({ capabilityId: x.c.id, name: x.c.name, reason: `duplicates or overlaps ${clash.name}` }), seenExcluded.add(x.c.id);
            continue;
          }
          if (!winner) {
            winner = x;
            continue;
          }
          if (!seenExcluded.has(x.c.id) && excluded.length < 10 && excluded.filter((e) => e.reason.includes(d.title)).length < 2) {
            excluded.push({ capabilityId: x.c.id, name: x.c.name, reason: `ranked below ${winner.c.name} for ${d.title} (${x.score.toFixed(2)} vs ${winner.score.toFixed(2)})` });
            seenExcluded.add(x.c.id);
          }
        }
        if (winner) {
          selected.push({
            capabilityId: winner.c.id, name: winner.c.name, kind: winner.c.kind as any, role: d.title, score: Number(winner.score.toFixed(3)), installed: winner.installed, cost: winner.c.contextCost, domain: d.direct ? winner.c.domain : d.id,
            reasons: [d.direct ? `its description covers ${winner.termHits.length} of ${specific.length} distinctive task terms` : `matches ${d.title}: ${winner.domainHits.slice(0, 4).join(', ')}`, `task terms: ${winner.termHits.slice(0, 5).join(', ')}`, winner.elig.reason, winner.c.quality != null ? `quality ${winner.c.quality}` : 'quality not scored', `trust ${winner.c.trust}, tier ${winner.c.tier}`],
          });
        } else if (!d.direct && analysis.complexity !== 'trivial' && (d.score >= 2 || d.id === analysis.domains[0]?.id)) {
          gaps.push({ domain: d.id, term: d.matched.slice(0, 3).join(' '), reason: scored.length ? 'matching capabilities exist but none is approved or installed' : 'no capability in the registry matches this part of the task' });
        }
      }

      // Context budget: drop the weakest selections until the estimated load fits.
      selected.sort((a, b) => b.score - a.score);
      while (selected.reduce((n, s) => n + s.cost, 0) > CONTEXT_BUDGET && selected.length > 1) {
        const dropped = selected.pop()!;
        excluded.push({ capabilityId: dropped.capabilityId, name: dropped.name, reason: `dropped to stay within the ${CONTEXT_BUDGET}-token context budget` });
      }

      const plan = STAGE_ORDER.map((stage) => ({ stage, caps: selected.filter((s) => (domainById(s.domain)?.stage ?? 'build') === stage) }))
        .filter((x) => x.caps.length)
        .map((x, i) => ({ step: i + 1, stage: x.stage, capabilityIds: x.caps.map((c) => c.capabilityId), verify: VERIFY[x.stage] }));

      return { task, strategy: 'lexical-graph-v1', analysis, selected: selected.map(({ cost, domain, ...s }) => s), excluded, gaps, plan };
    },
  };
}

/** The strategy named in settings (`routing.strategy`); v2 unless v1 is asked for by name. */
export function defaultStrategy(sys: Sys): RoutingStrategy {
  return (sys.settings() as any).routing?.strategy === 'lexical-graph-v1' ? lexicalGraphStrategy(sys) : evidenceStrategy(sys);
}

/** Routes a task, persists the decision and any capability gaps, and returns it with its id. */
export function routeTask(sys: Sys, task: string, opts: { origin?: string; host?: string; strategy?: RoutingStrategy } = {}): RouteDecision & { id: number } {
  if (!task.trim()) throw new Error('Task text is empty');
  const d = (opts.strategy ?? defaultStrategy(sys)).route(task, { host: opts.host });
  const now = nowIso();
  const id = Number(sys.db.run('INSERT INTO route_decisions (task, origin, strategy, analysis, selected, excluded, gaps, plan, created_at) VALUES (?,?,?,?,?,?,?,?,?)', task, opts.origin ?? 'cli', d.strategy, j({ ...d.analysis, metrics: d.metrics }), j(d.selected), j(d.excluded), j(d.gaps), j(d.plan), now).lastInsertRowid);
  for (const g of d.gaps) {
    sys.db.run("INSERT INTO gaps (term, domain, hits, sample_task, status, first_seen_at, last_seen_at) VALUES (?,?,1,?,'open',?,?) ON CONFLICT(term) DO UPDATE SET hits = hits + 1, last_seen_at = excluded.last_seen_at, sample_task = excluded.sample_task", g.term, g.domain, task.slice(0, 300), now, now);
    emit(sys.db, 'gap.detected', g.term, { domain: g.domain, decisionId: id }, opts.origin);
  }
  emit(sys.db, 'route.decided', String(id), { complexity: d.analysis.complexity, selected: d.selected.map((s) => s.capabilityId), gaps: d.gaps.length }, opts.origin);
  return { ...d, id };
}

/** Stores what a host was actually sent for a decision, so context overhead is measured, not assumed. */
export function recordHostContext(sys: Sys, decisionId: number, sent: { injectedTokens: number; injectedBytes: number; offered: string[]; hookMs?: number }) {
  const row = sys.db.get<{ analysis: string }>('SELECT analysis FROM route_decisions WHERE id = ?', decisionId);
  if (!row) return;
  const analysis = pj<any>(row.analysis, {});
  analysis.metrics = { ...(analysis.metrics ?? {}), ...sent };
  sys.db.run('UPDATE route_decisions SET analysis = ? WHERE id = ?', j(analysis), decisionId);
}

export function explain(d: RouteDecision): string {
  const lines = [`Task classified as ${d.analysis.complexity}${d.analysis.sensitivity === 'elevated' ? ', sensitivity elevated' : ''}; domains: ${d.analysis.domains.map((x) => `${x.id}(${x.matched.slice(0, 3).join(',')})`).join(' ') || 'none recognised'}.`];
  if (d.analysis.intent && d.analysis.intent.kind !== 'substantive') lines.push('Not treated as a task (' + d.analysis.intent.kind + ': ' + d.analysis.intent.reason + ').');
  if (d.selected.length) {
    lines.push('Selected:');
    for (const s of d.selected) lines.push(`  ${s.role}: ${s.name} [${s.capabilityId}] score ${s.score}${s.installed ? ', installed' : ''} — ${s.reasons.slice(0, 3).join('; ')}`);
  } else lines.push('Selected: nothing. Proceed without added capabilities.');
  if (d.excluded.length) {
    lines.push('Excluded:');
    for (const e of d.excluded.slice(0, 6)) lines.push(`  ${e.name}: ${e.reason}`);
  }
  if (d.gaps.length) {
    lines.push('Gaps:');
    for (const g of d.gaps) lines.push(`  ${g.domain} (${g.term}): ${g.reason}`);
  }
  if (d.metrics) lines.push('Cost: routed in ' + d.metrics.ms + ' ms; ' + d.metrics.candidates + ' candidate(s), ' + d.metrics.qualified + ' above the confidence floor' + (d.metrics.injectedTokens != null ? '; ' + d.metrics.injectedTokens + ' token(s) sent to the host' : '') + '.');
  if (d.plan.length) {
    lines.push('Plan:');
    for (const p of d.plan) lines.push(`  ${p.step}. ${p.stage}: ${p.capabilityIds.join(', ')} — verify: ${p.verify}`);
  }
  return lines.join('\n');
}

/* ---------- plan-only workflow executor ---------- */

export const planOnlyExecutor: WorkflowExecutor = {
  id: 'plan-only',
  async execute(decision) {
    return { status: 'planned', trace: decision.plan.map((p) => ({ step: p.step, stage: p.stage, capabilities: p.capabilityIds, verify: p.verify, executed: false, note: 'execution is performed by the host agent; Synaptome records activations and outcomes' })) };
  },
};

/* =====================================================================
 * ACTIVATION: serve one capability for one task, and record it.
 * ===================================================================== */

export class ActivationError extends Error {
  constructor(public code: 'not-found' | 'not-eligible', message: string) {
    super(message);
  }
}

export interface Activation {
  activationId: number;
  capability: { id: string; name: string; kind: string; trust: string; tier: string };
  entryPath: string;
  content: string;
  otherFiles: string[];
  basePath: string;
  notice: string;
}

export function activate(sys: Sys, input: { capabilityId: string; decisionId?: number | null; host: string; reason?: string }): Activation {
  const cap = getCapability(sys, input.capabilityId);
  if (!cap) throw new ActivationError('not-found', `No capability "${input.capabilityId}"`);
  const el = baseEligibility(cap);
  if (!el.ok) throw new ActivationError('not-eligible', `${cap.id} cannot be activated: ${el.reason}`);
  const entry = readCapabilityEntry(sys, cap.id);
  if (!entry) throw new ActivationError('not-found', `${cap.id} has no readable entry file`);
  const activationId = Number(sys.db.run('INSERT INTO activations (decision_id, capability_id, host, reason, served_bytes, served_at) VALUES (?,?,?,?,?,?)', input.decisionId ?? null, cap.id, input.host, input.reason ?? null, Buffer.byteLength(entry.content), nowIso()).lastInsertRowid);
  emit(sys.db, 'capability.activated', cap.id, { activationId, decisionId: input.decisionId ?? null, host: input.host, bytes: Buffer.byteLength(entry.content) });
  return {
    activationId,
    capability: { id: cap.id, name: cap.name, kind: cap.kind, trust: cap.trust, tier: cap.tier },
    entryPath: entry.path,
    content: entry.content,
    otherFiles: entry.files.filter((f) => f !== entry.path && !f.startsWith('.upstream/')).slice(0, 60),
    basePath: entry.base,
    notice: `Capability "${cap.name}" served by Synaptome (trust ${cap.trust}, tier ${cap.tier}). Treat it as reference guidance for the current task; the user's own instructions take precedence.`,
  };
}

export function recordOutcome(sys: Sys, input: { decisionId?: number | null; activationId?: number | null; outcome: 'success' | 'partial' | 'failed'; detail?: string }): number {
  const where = input.activationId ? 'id = ?' : 'decision_id = ?';
  const key = input.activationId ?? input.decisionId;
  if (key == null) throw new Error('recordOutcome needs a decisionId or an activationId');
  const r = sys.db.run(`UPDATE activations SET outcome=?, outcome_detail=?, outcome_at=? WHERE ${where}`, input.outcome, (input.detail ?? '').slice(0, 2000), nowIso(), key);
  emit(sys.db, 'route.outcome', String(input.decisionId ?? input.activationId), { outcome: input.outcome, activations: Number(r.changes) });
  return Number(r.changes);
}

/* ---------- read models ---------- */

const mapDecision = (r: any) => ({ metrics: pj<any>(r.analysis, {})?.metrics as RouteDecision['metrics'], id: r.id as number, task: r.task as string, origin: r.origin as string, strategy: r.strategy as string, analysis: pj<TaskAnalysis>(r.analysis, {} as TaskAnalysis), selected: pj<RouteSelection[]>(r.selected, []), excluded: pj<RouteDecision['excluded']>(r.excluded, []), gaps: pj<RouteDecision['gaps']>(r.gaps, []), plan: pj<RouteDecision['plan']>(r.plan, []), createdAt: r.created_at as string });
export function listDecisions(sys: Sys, limit = 30) {
  return sys.db.all<any>('SELECT * FROM route_decisions ORDER BY id DESC LIMIT ?', limit).map(mapDecision);
}
export function getDecision(sys: Sys, id: number) {
  const r = sys.db.get<any>('SELECT * FROM route_decisions WHERE id=?', id);
  return r ? { ...mapDecision(r), activations: listActivations(sys, { decisionId: id }) } : null;
}
export function listActivations(sys: Sys, f: { decisionId?: number; limit?: number } = {}) {
  return sys.db.all<any>(`SELECT a.*, c.name FROM activations a LEFT JOIN capabilities c ON c.id = a.capability_id ${f.decisionId ? 'WHERE a.decision_id = ?' : ''} ORDER BY a.id DESC LIMIT ?`, ...(f.decisionId ? [f.decisionId] : []), f.limit ?? 50);
}
export function listGaps(sys: Sys, status?: string) {
  return sys.db.all<any>(`SELECT * FROM gaps ${status ? 'WHERE status = ?' : ''} ORDER BY hits DESC, last_seen_at DESC`, ...(status ? [status] : []));
}
