import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ModelProvider, setSetting, tempSystem } from '@synaptome/core';
import { buildProviders } from '@synaptome/providers';
import { approveStep, cancelRun, defaultRunners, findWorkflow, getRun, runWorkflow, startRun } from '@synaptome/workflow';
import { agentRunner, overBudget, parseContract, readBoard, trace } from '../src/index';

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

  it('stops when the run budget is spent, before the next model call', async () => {
    const { provider, calls } = fakeClaude();
    const id = startRun(sys, { ...team(), budget: { tokens: 2000 } }, { task: 'x', workdir: repo });
    const r = await runWorkflow(sys, id, { runners: runnersWith(provider) });
    expect(r.status).toBe('failed');
    expect(calls.map((c) => c.role)).toEqual(['researcher', 'architect']); // 1100 + 1100 tokens, then the limit
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'implement')!.error).toBe('budget: token budget used: 2200 of 2000');
    expect(overBudget(sys, id)).toMatch(/token budget/);
  });

  it('a USD budget with unknown prices stops instead of guessing', async () => {
    const { provider } = fakeClaude();
    const id = startRun(sys, { ...team(), budget: { usd: 1 } }, { task: 'x', workdir: repo });
    await runWorkflow(sys, id, { runners: runnersWith(provider) });
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'design')!.error).toMatch(/cost of earlier calls is unknown/);
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
