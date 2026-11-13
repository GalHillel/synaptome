import { type RouteDecision, type RoutingStrategy, type Sys, estimateTokens, upsertCapability, writeSnapshot } from '@synaptome/core';
import { BENCH_CAPABILITIES } from './registry';
import { BENCH_TASKS, type BenchCategory, type BenchTask, isHeldOut } from './tasks';

/** Seeds the fixture registry into a (temporary) system as approved, audited skills. */
export function seedBenchmark(sys: Sys): number {
  for (const cap of BENCH_CAPABILITIES) {
    const body = `---\nname: ${cap.name}\ndescription: ${cap.description}\n---\n# ${cap.name}\n\n${cap.description}\n\n## Guidance\n\n${'Detailed guidance for this capability. '.repeat(120)}\n`;
    const files = [{ path: 'SKILL.md', content: body, size: Buffer.byteLength(body) }];
    const snap = writeSnapshot(sys, cap.id, files);
    upsertCapability(
      sys,
      { id: cap.id, name: cap.name, description: cap.description, kind: 'skill', domain: cap.domain, tags: cap.tags, entryFile: 'SKILL.md', contextCost: estimateTokens(body), quality: { total: 90 }, security: { tier: 'A', trust: 'REVIEWED_COMMUNITY' } },
      { status: 'approved', contentHash: snap.contentHash, snapshotPath: snap.snapshotPath, body },
    );
  }
  return BENCH_CAPABILITIES.length;
}

export interface BenchMetrics {
  tasks: number;
  /** Capabilities selected across all tasks, and how many of them were acceptable for their task. */
  selected: number;
  correct: number;
  precision: number;
  /** Distinct needs across tasks that expect something, and how many were met. */
  needs: number;
  needsMet: number;
  recall: number;
  /** Tasks that must select nothing, and how many selected something anyway. */
  mustBeEmpty: number;
  falseActivations: number;
  falseActivationRate: number;
  /** Tasks where a capability named in `forbid` was selected. */
  forbidViolations: number;
}

export interface BenchFailure {
  id: string;
  category: BenchCategory;
  heldOut: boolean;
  task: string;
  selected: string[];
  wrong: string[];
  missing: string[][];
}

export interface BenchResult {
  strategy: string;
  capabilities: number;
  all: BenchMetrics;
  tuning: BenchMetrics;
  heldOut: BenchMetrics;
  byCategory: Record<string, BenchMetrics>;
  latencyMs: { p50: number; p95: number; max: number };
  injectedTokens: { mean: number; p95: number; max: number; maxWhenNothingQualifies: number; maxPerCapability: number };
  failures: BenchFailure[];
}

const pct = (a: number, b: number) => (b === 0 ? 1 : Number((a / b).toFixed(4)));
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

interface Row {
  task: BenchTask;
  selected: string[];
  wrong: string[];
  missing: string[][];
  ms: number;
  tokens: number;
  perCapabilityTokens: number;
}

function metrics(rows: Row[]): BenchMetrics {
  let selected = 0;
  let correct = 0;
  let needs = 0;
  let needsMet = 0;
  let mustBeEmpty = 0;
  let falseActivations = 0;
  let forbidViolations = 0;
  for (const r of rows) {
    selected += r.selected.length;
    correct += r.selected.length - r.wrong.length;
    needs += r.task.expect.length;
    needsMet += r.task.expect.length - r.missing.length;
    if (!r.task.expect.length) {
      mustBeEmpty++;
      if (r.selected.length) falseActivations++;
    }
    if (r.task.forbid.some((f) => r.selected.includes(f))) forbidViolations++;
  }
  return { tasks: rows.length, selected, correct, precision: pct(correct, selected), needs, needsMet, recall: pct(needsMet, needs), mustBeEmpty, falseActivations, falseActivationRate: mustBeEmpty ? Number((falseActivations / mustBeEmpty).toFixed(4)) : 0, forbidViolations };
}

/**
 * Runs every benchmark task through a strategy without persisting decisions.
 * `render` returns what the prompt hook would inject for a decision, so context overhead is measured on the
 * same output a host would receive; `perCapability` returns the injected text attributable to one capability.
 */
export function runBenchmark(
  sys: Sys,
  strategy: RoutingStrategy,
  opts: { render?: (d: RouteDecision) => string; perCapability?: (d: RouteDecision) => string[]; tasks?: BenchTask[] } = {},
): BenchResult {
  const tasks = opts.tasks ?? BENCH_TASKS;
  strategy.route('warm up the statement cache'); // first call pays one-off preparation costs
  const rows: Row[] = tasks.map((task) => {
    const t0 = performance.now();
    const d = strategy.route(task.task);
    const ms = performance.now() - t0;
    const selected = d.selected.map((s) => s.capabilityId);
    const acceptable = new Set([...task.expect.flat(), ...task.allow]);
    const wrong = selected.filter((id) => !acceptable.has(id));
    const missing = task.expect.filter((slot) => !slot.some((id) => selected.includes(id)));
    const injected = opts.render ? opts.render(d) : '';
    const parts = opts.perCapability ? opts.perCapability(d) : [];
    return { task, selected, wrong, missing, ms, tokens: estimateTokens(injected), perCapabilityTokens: Math.max(0, ...parts.map((p) => estimateTokens(p))) };
  });
  const byCategory: Record<string, BenchMetrics> = {};
  for (const cat of [...new Set(tasks.map((t) => t.category))]) byCategory[cat] = metrics(rows.filter((r) => r.task.category === cat));
  const tokens = rows.map((r) => r.tokens);
  return {
    strategy: strategy.id,
    capabilities: sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM capabilities')!.n,
    all: metrics(rows),
    tuning: metrics(rows.filter((r) => !isHeldOut(r.task))),
    heldOut: metrics(rows.filter((r) => isHeldOut(r.task))),
    byCategory,
    latencyMs: { p50: Number(quantile(rows.map((r) => r.ms), 0.5).toFixed(2)), p95: Number(quantile(rows.map((r) => r.ms), 0.95).toFixed(2)), max: Number(Math.max(...rows.map((r) => r.ms)).toFixed(2)) },
    injectedTokens: {
      mean: Math.round(tokens.reduce((a, b) => a + b, 0) / (tokens.length || 1)),
      p95: quantile(tokens, 0.95),
      max: Math.max(0, ...tokens),
      maxWhenNothingQualifies: Math.max(0, ...rows.filter((r) => !r.selected.length).map((r) => r.tokens)),
      maxPerCapability: Math.max(0, ...rows.map((r) => r.perCapabilityTokens)),
    },
    failures: rows.filter((r) => r.wrong.length || r.missing.length).map((r) => ({ id: r.task.id, category: r.task.category, heldOut: isHeldOut(r.task), task: r.task.task, selected: r.selected, wrong: r.wrong, missing: r.missing })),
  };
}

export function formatBenchmark(r: BenchResult): string {
  const line = (name: string, m: BenchMetrics) =>
    `${name.padEnd(20)} tasks ${String(m.tasks).padStart(3)}  precision ${(m.precision * 100).toFixed(1).padStart(5)}%  recall ${(m.recall * 100).toFixed(1).padStart(5)}%  false activation ${(m.falseActivationRate * 100).toFixed(1).padStart(5)}% (${m.falseActivations}/${m.mustBeEmpty})  forbidden ${m.forbidViolations}`;
  return [
    `strategy ${r.strategy} on ${r.capabilities} capabilities`,
    line('all', r.all),
    line('tuning set', r.tuning),
    line('held-out set', r.heldOut),
    '',
    ...Object.entries(r.byCategory).map(([k, m]) => line(k, m)),
    '',
    `routing latency   p50 ${r.latencyMs.p50} ms   p95 ${r.latencyMs.p95} ms   max ${r.latencyMs.max} ms`,
    `injected context  mean ${r.injectedTokens.mean}   p95 ${r.injectedTokens.p95}   max ${r.injectedTokens.max} tokens (estimated); max per capability ${r.injectedTokens.maxPerCapability}; when nothing qualifies ${r.injectedTokens.maxWhenNothingQualifies}`,
  ].join('\n');
}
