import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ModelProvider, openSystem, setSetting, tempSystem } from '@synaptome/core';
import { buildProviders } from '@synaptome/providers';
import { approveStep, cancelRun, defaultRunners, findWorkflow, getRun, runWorkflow, startRun } from '@synaptome/workflow';
import { BudgetRefused, abandon, agentRunner, committed, parseContract, readBoard, release, reservations, reserve, trace } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
let repo: string;
beforeEach(() => {
  sys = tempSystem();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-team-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  const id = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-q', '-m', 'start'], { cwd: repo, env: id });
});
afterEach(() => {
  sys.dispose();
  fs.rmSync(repo, { recursive: true, force: true });
});

interface Call { role: string; prompt: string; cwd?: string; args?: string[]; at: number }
/** A deterministic stand-in for headless Claude Code: answers by role, with the json contract, after a delay. */
function fakeClaude(opts: { review?: ('pass' | 'changes')[]; failFirst?: string; delayMs?: number } = {}) {
  const calls: Call[] = [];
  const reviews = [...(opts.review ?? ['pass'])];
  let failed = false;
  const provider: ModelProvider = {
    id: 'claude-code-headless',
    title: 'fake',
    availability: async () => ({ available: true, authenticated: true, detail: 'fake' }),
    async complete(req) {
      const role = /research specialist/.test(req.system!) ? 'researcher' : /architect/.test(req.system!) ? 'architect' : /implementer/.test(req.system!) ? 'implementer' : /reviewer/.test(req.system!) ? 'reviewer' : 'tester';
      const at = Date.now();
      calls.push({ role, prompt: req.prompt, cwd: req.cwd, args: req.extraArgs, at });
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 20));
      if (opts.failFirst === role && !failed) {
        failed = true;
        return { ok: false, text: '', error: 'overloaded', ms: 5 };
      }
      if (role === 'implementer') fs.writeFileSync(path.join(req.cwd!, 'feature.js'), `// ${calls.length}\n`);
      const verdict = role === 'reviewer' ? (reviews.shift() ?? 'pass') : role === 'tester' ? 'pass' : 'n/a';
      const notes = role === 'architect' ? { entry: 'feature.js' } : role === 'reviewer' && verdict === 'changes' ? { fix: 'handle empty input' } : {};
      return { ok: true, text: `${role} did its part.\n\`\`\`json\n${JSON.stringify({ summary: `${role} summary`, verdict, notes })}\n\`\`\``, ms: 20, usage: { inputTokens: 1000, outputTokens: 100 } };
    },
  };
  return { provider, calls };
}

const team = () => findWorkflow(sys, 'team.build')!.def;
const runnersWith = (p: ModelProvider) => defaultRunners({ agent: agentRunner({ providers: buildProviders(sys, { env: {}, claude: p }) }) });
/** Runs until done, approving every test step as it comes up (the operator's decision in these tests). */
async function runApproving(id: string, p: ModelProvider) {
  for (let i = 0; i < 6; i++) {
    const r = await runWorkflow(sys, id, { runners: runnersWith(p) });
    if (r.status !== 'waiting') return r;
    for (const s of getRun(sys, id)!.steps.filter((x) => x.status === 'waiting')) approveStep(sys, id, s.id, { by: 'tester', approve: true });
  }
  throw new Error('did not finish');
}

describe('agent team on the workflow engine', () => {
  it('hands work from agent to agent, shares notes, waits before running tests, and leaves a full trace', async () => {
    const { provider, calls } = fakeClaude();
    const id = startRun(sys, team(), { task: 'add a feature', workdir: repo });
    const first = await runWorkflow(sys, id, { runners: runnersWith(provider) });
    expect(first.status).toBe('waiting'); // the tester needs "shell": a person approves before tests run
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'test')!.status).toBe('waiting');
    const r = await runApproving(id, provider);
    expect(r.status).toBe('succeeded');
    expect(calls.map((c) => c.role)).toEqual(['researcher', 'architect', 'implementer', 'reviewer', 'tester']);
    // hand-offs: the architect sees the research, the implementer sees the plan; notes reach later agents
    expect(calls[1].prompt).toContain('### From research\nresearcher did its part.');
    expect(calls[2].prompt).toContain('### From plan\narchitect did its part.');
    expect(calls[3].prompt).toContain('- entry (from design): feature.js');
    expect(readBoard(sys, id)).toEqual({ entry: { value: 'feature.js', by: 'design' } });
    // tool scopes follow the role: readers read, the implementer edits, the tester may run tests
    expect(calls[0].args).not.toContain('Edit');
    expect(calls[2].args).toEqual(expect.arrayContaining(['Edit', 'Write', 'acceptEdits']));
    expect(calls[4].args).toEqual(expect.arrayContaining(['Bash(npm test:*)']));
    expect(calls.every((c) => c.cwd === path.resolve(repo))).toBe(true);
    const t = trace(sys, id)!;
    expect(t.calls).toHaveLength(5);
    expect(t.totals).toMatchObject({ tokens: 5500, calls: 5, usd: null }); // no price configured: cost unknown, not zero
    const report = getRun(sys, id)!.steps.find((s) => s.id === 'report')!.output as any;
    expect(report).toMatchObject({ review: 'pass', tests: 'pass', repair: 'skipped', implementation: 'implementer summary' });
    expect(report.changes.status).toEqual(['?? feature.js']);
  });

  it('runs review and tests in parallel after implementation', async () => {
    // With the default settings the test step waits for approval, which serialises it; here the owner has chosen
    // not to require approval for "shell", so the two branches run side by side.
    setSetting(sys.db, 'workflow.approvalRequiredFor', []);
    const { provider, calls } = fakeClaude({ delayMs: 300 });
    const id = startRun(sys, team(), { task: 'x', workdir: repo });
    expect((await runWorkflow(sys, id, { runners: runnersWith(provider) })).status).toBe('succeeded');
    const review = calls.find((c) => c.role === 'reviewer')!;
    const test = calls.find((c) => c.role === 'tester')!;
    expect(test.at).toBeLessThan(review.at + 300); // the tester started before the reviewer's 300 ms call had finished
  });

  it('a review that asks for changes triggers one repair round and a final test run', async () => {
    const { provider, calls } = fakeClaude({ review: ['changes'] });
    const id = startRun(sys, team(), { task: 'x', workdir: repo });
    const r = await runApproving(id, provider);
    expect(r.status).toBe('succeeded');
    expect(calls.map((c) => c.role)).toEqual(['researcher', 'architect', 'implementer', 'reviewer', 'tester', 'implementer', 'tester']);
    expect(calls[5].prompt).toContain('### From review');
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'report')!.output as any).toMatchObject({ review: 'changes', repair: 'succeeded', finalTests: 'pass' });
  });

  it('recovers from a failed model call by retrying the step', async () => {
    const { provider, calls } = fakeClaude({ failFirst: 'researcher' });
    const id = startRun(sys, team(), { task: 'x', workdir: repo });
    await runApproving(id, provider);
    expect(calls.filter((c) => c.role === 'researcher')).toHaveLength(2);
    expect(trace(sys, id)!.calls[0]).toMatchObject({ ok: false, error: 'overloaded' });
  });

  it('starts a call only when its worst case fits the budget (W6: never spends past the limit)', async () => {
    // Each agentic call reserves 6000 tokens; the fake reports 1100. Budget 7000: research fits (0 + 6000), the next
    // call would not (1100 actual + 6000 reserved > 7000), so it is refused before it starts. The old check let both
    // run and stopped only after 2200 of 2000 were spent.
    setSetting(sys.db, 'workflow.agenticCallTokens', 6000);
    const { provider, calls } = fakeClaude();
    const id = startRun(sys, { ...team(), budget: { tokens: 7000 } }, { task: 'x', workdir: repo });
    const r = await runWorkflow(sys, id, { runners: runnersWith(provider) });
    expect(r.status).toBe('failed');
    expect(calls.map((c) => c.role)).toEqual(['researcher']);
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'design')!.error).toMatch(/^budget: token budget: 1100 committed .* \+ 6000 for this call > 7000$/);
    expect(trace(sys, id)!.totals.tokens).toBeLessThanOrEqual(7000);
    expect(trace(sys, id)!.reservations.map((x: any) => x.status)).toEqual(['settled']);
  });

  it('a USD budget with unknown prices stops instead of guessing', async () => {
    const { provider } = fakeClaude();
    const id = startRun(sys, { ...team(), budget: { usd: 1 } }, { task: 'x', workdir: repo });
    await runWorkflow(sys, id, { runners: runnersWith(provider) });
    // Strict: with no price configured the very first call is refused (an unknown cost never fits a USD budget).
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'research')!.error).toMatch(/USD budget is set but the cost is unknown/);
  });

  it('can be cancelled mid-run', async () => {
    const { provider } = fakeClaude({ delayMs: 3000 });
    const id = startRun(sys, team(), { task: 'x', workdir: repo });
    const p = runWorkflow(sys, id, { runners: runnersWith(provider) });
    await new Promise((r) => setTimeout(r, 200));
    cancelRun(sys, id, 'tester');
    expect((await p).status).toBe('cancelled');
  });

  it('refuses to let an agent edit outside a git repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-plain-'));
    try {
      const { provider, calls } = fakeClaude();
      const id = startRun(sys, team(), { task: 'x', workdir: plain });
      const r = await runWorkflow(sys, id, { runners: runnersWith(provider) });
      expect(r.status).toBe('failed');
      expect(getRun(sys, id)!.steps.find((s) => s.id === 'implement')!.error).toMatch(/is not a git repository/);
      expect(calls.map((c) => c.role)).toEqual(['researcher', 'architect']); // readers may read; nobody edited
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('reads the answer contract, and degrades gracefully when it is missing', () => {
    expect(parseContract('text\n```json\n{"summary":"s","verdict":"changes","notes":{"a":1}}\n```')).toEqual({ summary: 's', verdict: 'changes', notes: { a: 1 }, parsed: true });
    expect(parseContract('no block here')).toMatchObject({ verdict: 'n/a', parsed: false, summary: 'no block here' });
  });
});

describe('budget reservations (W6)', () => {
  const parallelDef = (n: number, budget: Record<string, number>) => ({
    id: 'w6.parallel', version: '1', title: 'parallel', description: 'n parallel agent calls', inputs: { workdir: { type: 'string', description: 'repo' } },
    permissions: ['api'], budget,
    steps: Array.from({ length: n }, (_, i) => ({ id: 's' + i, title: 's' + i, kind: 'agent', permissions: ['api'], with: { agent: 'researcher', task: 'look', workdir: '${inputs.workdir}' } })),
  }) as any;

  it('parallel steps cannot together exceed the token budget: only calls whose worst case fits are started', async () => {
    setSetting(sys.db, 'workflow.agenticCallTokens', 5000);
    setSetting(sys.db, 'workflow.maxParallel', 6);
    const { provider, calls } = fakeClaude({ delayMs: 300 }); // overlapping calls
    const id = startRun(sys, parallelDef(6, { tokens: 11_000 }), { workdir: repo });
    await runWorkflow(sys, id, { runners: runnersWith(provider) });
    // 11000 / 5000 = 2 worst cases at a time: with all six starting together, exactly two may start.
    expect(calls).toHaveLength(2);
    const steps = getRun(sys, id)!.steps;
    expect(steps.filter((s) => s.status === 'succeeded')).toHaveLength(2);
    expect(steps.filter((s) => /^budget: token budget/.test(s.error ?? ''))).toHaveLength(4);
    expect(trace(sys, id)!.totals.tokens).toBeLessThanOrEqual(11_000);
    expect(trace(sys, id)!.reservations.filter((x: any) => x.status === 'held')).toEqual([]);
  });

  it('a USD budget with prices: reservations use the price, actual cost replaces them, nothing passes the limit', async () => {
    setSetting(sys.db, 'workflow.agenticCallTokens', 5000);
    setSetting(sys.db, 'workflow.maxParallel', 6);
    setSetting(sys.db, 'providers.prices', { 'claude-code-headless': { input: 10, output: 10 } }); // $10 per million: 5000 tokens = $0.05
    const { provider, calls } = fakeClaude({ delayMs: 300 });
    const id = startRun(sys, parallelDef(5, { usd: 0.12 }), { workdir: repo });
    await runWorkflow(sys, id, { runners: runnersWith(provider) });
    expect(calls).toHaveLength(2); // 2 x $0.05 reserved fit in $0.12, a third would not
    const t = trace(sys, id)!;
    expect(t.totals.usd).toBeCloseTo((2 * 1100 * 10) / 1e6, 9);
    expect(t.totals.usd!).toBeLessThanOrEqual(0.12);
    expect(t.reservations.map((x: any) => x.status).sort()).toEqual(['settled', 'settled']);
  });

  it('two connections (as two processes) reserving at the same time cannot both take the last room', async () => {
    const id = startRun(sys, parallelDef(1, { tokens: 10_000 }), { workdir: repo });
    const other = openSystem(sys.home);
    try {
      const results = await Promise.allSettled([sys, other, sys, other].map((s, i) => Promise.resolve().then(() => reserve(s, id, 's' + i, { tokens: 4000, usd: null }))));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2); // 2 x 4000 <= 10000 < 3 x 4000
      expect(results.filter((r) => r.status === 'rejected').every((r: any) => r.reason instanceof BudgetRefused)).toBe(true);
      expect(committed(sys, id).tokens).toBe(8000);
    } finally {
      other.close();
    }
  });

  it('six processes reserving at the same instant: exactly as many succeed as the budget allows', async () => {
    const id = startRun(sys, parallelDef(1, { tokens: 10_000 }), { workdir: repo });
    const { spawn } = await import('node:child_process');
    const child = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'reserve-child.ts');
    const startAt = Date.now() + 2500; // after all six have loaded
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise<string>((resolve) => {
          const p = spawn(process.execPath, ['--import', 'tsx', child, sys.home, id, '4000', String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          p.stdout.on('data', (d) => (out += d));
          p.stderr.on('data', (d) => (out += d));
          p.on('close', () => resolve(out.trim()));
        }),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(2); // 2 x 4000 <= 10000 < 3 x 4000
    expect(results.filter((r) => r === 'refused')).toHaveLength(4);
    expect(committed(sys, id).tokens).toBe(8000);
  }, 60_000);

  it('a cancelled call with no reported usage keeps counting at its estimate; a released one does not', () => {
    const id = startRun(sys, parallelDef(1, { tokens: 50_000 }), { workdir: repo });
    const a = reserve(sys, id, 's0', { tokens: 3000, usd: null })!;
    const b = reserve(sys, id, 's0', { tokens: 2000, usd: null })!;
    abandon(sys, a, 'cancelled while the call ran; its cost is unknown');
    release(sys, b, 'rejected before processing');
    expect(committed(sys, id)).toMatchObject({ tokens: 3000, held: 0, abandoned: 3000 });
    expect(reservations(sys, id).map((x: any) => x.status)).toEqual(['abandoned', 'released']);
  });

  it('a reservation left by a process that died is abandoned (counted), never silently freed', () => {
    const id = startRun(sys, parallelDef(1, { tokens: 10_000 }), { workdir: repo });
    const now = new Date().toISOString();
    sys.db.run("INSERT INTO budget_reservations (run_id, step_id, holder, est_tokens, est_usd, status, created_at, updated_at) VALUES (?, 's0', '2147483646:0', 6000, NULL, 'held', ?, ?)", id, now, now);
    expect(() => reserve(sys, id, 's0', { tokens: 5000, usd: null })).toThrow(BudgetRefused); // 6000 + 5000 > 10000
    expect(reservations(sys, id)[0]).toMatchObject({ status: 'abandoned', reason: expect.stringMatching(/process ended/) });
    expect(reserve(sys, id, 's0', { tokens: 4000, usd: null })).not.toBeNull(); // 6000 + 4000 fits
  });

  it('cancelling a run mid-call abandons the reservation of the call that was running', async () => {
    const slow: ModelProvider = {
      id: 'claude-code-headless',
      title: 'slow',
      availability: async () => ({ available: true, authenticated: true, detail: 'fake' }),
      complete: (req) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true, text: 'late', ms: 5000, usage: { inputTokens: 10, outputTokens: 10 } }), 5000);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ ok: false, text: '', error: 'aborted', ms: 1 });
          });
        }),
    };
    const id = startRun(sys, parallelDef(1, { tokens: 1_000_000 }), { workdir: repo });
    const p = runWorkflow(sys, id, { runners: runnersWith(slow) });
    await new Promise((r) => setTimeout(r, 300));
    cancelRun(sys, id, 'tester');
    expect((await p).status).toBe('cancelled');
    expect(reservations(sys, id).map((x: any) => x.status)).toEqual(['abandoned']);
  });
});
