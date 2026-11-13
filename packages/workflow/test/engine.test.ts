import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listNotifications, setSetting, tempSystem } from '@synaptome/core';
import {
  type Runners, type StepRunner, StepError, approveStep, apiCallRunner, cancelRun, getRun, listRuns, noopRunner, approvalRunner, runHistory, runWorkflow, shellRunner, startRun, validateWorkflow,
} from '../src/index';

let sys: ReturnType<typeof tempSystem>;
beforeEach(() => {
  sys = tempSystem();
});
afterEach(() => sys.dispose());

const runners: Runners = { noop: noopRunner, approval: approvalRunner, shell: shellRunner };
const wf = (steps: any[], extra: Record<string, unknown> = {}) => ({ id: 'test.flow', title: 'Test flow', steps, ...extra });
const run = (def: unknown, inputs: Record<string, unknown> = {}, r: Runners = runners, opts: { maxParallel?: number } = {}) => runWorkflow(sys, startRun(sys, def, inputs), { runners: r, ...opts });
const step = (runId: string, id: string) => getRun(sys, runId)!.steps.find((s) => s.id === id)!;

describe('definitions', () => {
  it('rejects cycles, unknown steps, undeclared permissions and references to steps that are not upstream', () => {
    const bad = (steps: any[], extra = {}) => {
      const v = validateWorkflow(wf(steps, extra));
      return v.ok ? [] : v.errors.join('\n');
    };
    expect(bad([{ id: 'a', kind: 'noop', needs: ['b'] }, { id: 'b', kind: 'noop', needs: ['a'] }])).toMatch(/cycle/);
    expect(bad([{ id: 'a', kind: 'noop', needs: ['zzz'] }])).toMatch(/unknown step "zzz"/);
    expect(bad([{ id: 'a', kind: 'noop', permissions: ['network'] }])).toMatch(/asks for "network", which the workflow does not declare/);
    expect(bad([{ id: 'a', kind: 'shell', permissions: [] }])).toMatch(/does not declare the "shell" permission/);
    expect(bad([{ id: 'a', kind: 'noop' }, { id: 'b', kind: 'noop', with: { x: '${steps.a.output}' } }])).toMatch(/refers to step "a", which it does not/);
    expect(bad([{ id: 'a', kind: 'noop', with: { x: '${inputs.nope}' } }])).toMatch(/undeclared input "nope"/);
    expect(bad([{ id: 'a', kind: 'noop', with: { x: '${process.env.HOME}' } }])).toMatch(/unknown reference/);
    expect(bad([{ id: 'A', kind: 'noop' }])).toMatch(/lowercase/);
    expect(() => startRun(sys, wf([{ id: 'a', kind: 'noop' }], { inputs: { n: { type: 'number' } } }), { n: 'x' })).toThrow(/input "n" must be number/);
  });
});

describe('execution', () => {
  it('runs steps in dependency order, passing outputs along, and records a reconstructable history', async () => {
    const r = await run(wf([
      { id: 'fetch', kind: 'noop', with: { value: { items: ['a', 'b'], name: '${inputs.who}' } } },
      { id: 'count', kind: 'noop', needs: ['fetch'], with: { value: { n: '${steps.fetch.output.items}', label: 'for ${steps.fetch.output.name}' } }, output: { required: ['n'], types: { n: 'array' } } },
    ], { inputs: { who: { type: 'string' } } }), { who: 'ada' });
    expect(r.status).toBe('succeeded');
    expect(step(r.runId, 'count').output).toEqual({ n: ['a', 'b'], label: 'for ada' });
    const types = runHistory(sys, r.runId).map((e) => e.type);
    expect(types).toEqual(['workflow.run-started', 'workflow.step-started', 'workflow.step-succeeded', 'workflow.step-started', 'workflow.step-succeeded', 'workflow.run-finished']);
    expect(listRuns(sys)[0]).toMatchObject({ id: r.runId, status: 'succeeded' });
  });

  it('runs independent branches in parallel, up to the limit', async () => {
    const def = wf([
      { id: 'a', kind: 'noop', with: { sleepMs: 200 } },
      { id: 'b', kind: 'noop', with: { sleepMs: 200 } },
      { id: 'c', kind: 'noop', with: { sleepMs: 200 } },
      { id: 'join', kind: 'noop', needs: ['a', 'b', 'c'] },
    ]);
    let t = Date.now();
    expect((await run(def, {}, runners, { maxParallel: 3 })).status).toBe('succeeded');
    const parallel = Date.now() - t;
    t = Date.now();
    await run(def, {}, runners, { maxParallel: 1 });
    const serial = Date.now() - t;
    expect(parallel).toBeLessThan(450);
    expect(serial).toBeGreaterThanOrEqual(590);
  });

  it('retries with backoff, then succeeds; stops retrying on a non-retryable error', async () => {
    let calls = 0;
    const flaky: StepRunner = async () => {
      calls++;
      if (calls < 3) throw new Error(`transient ${calls}`);
      return { output: { ok: true } };
    };
    const r = await run(wf([{ id: 'x', kind: 'noop', retry: { max: 3, backoffMs: 10 } }]), {}, { noop: flaky });
    expect(r.status).toBe('succeeded');
    expect(step(r.runId, 'x').attempts).toBe(3);
    expect(runHistory(sys, r.runId).filter((e) => e.type === 'workflow.step-retrying')).toHaveLength(2);

    const r2 = await run(wf([{ id: 'x', kind: 'noop', retry: { max: 3, backoffMs: 10 }, with: { fail: 'bad input', retryable: false } }]));
    expect(r2.status).toBe('failed');
    expect(step(r2.runId, 'x')).toMatchObject({ attempts: 1, error: 'bad input' });
  });

  it('times out a step that runs too long', async () => {
    const r = await run(wf([{ id: 'slow', kind: 'noop', timeoutMs: 50, with: { sleepMs: 2000 } }]));
    expect(r.status).toBe('failed');
    expect(step(r.runId, 'slow').error).toMatch(/timed out after 50 ms/);
  });

  it('fails a step whose output breaks its contract, and skips what depends on a failed step', async () => {
    const r = await run(wf([
      { id: 'a', kind: 'noop', with: { value: { n: 'three' } }, output: { required: ['n', 'm'], types: { n: 'number' } } },
      { id: 'b', kind: 'noop', needs: ['a'] },
      { id: 'side', kind: 'noop' },
    ]));
    expect(r.status).toBe('failed');
    expect(step(r.runId, 'a').error).toMatch(/output contract violated: output is missing "m"; output "n" must be number/);
    expect(step(r.runId, 'b')).toMatchObject({ status: 'skipped', error: 'needs "a", which failed' });
    expect(step(r.runId, 'side').status).toBe('succeeded');
  });

  it('continueOnError lets dependents run; a false condition skips a step and its dependents', async () => {
    const r = await run(wf([
      { id: 'optional', kind: 'noop', continueOnError: true, with: { fail: 'not available', retryable: false } },
      { id: 'after', kind: 'noop', needs: ['optional'] },
      { id: 'probe', kind: 'noop', with: { value: { tier: 'B' } } },
      { id: 'only-a', kind: 'noop', needs: ['probe'], when: { path: 'steps.probe.output.tier', equals: 'A' } },
      { id: 'then', kind: 'noop', needs: ['only-a'] },
    ]));
    expect(r.status).toBe('succeeded');
    expect(r.steps).toEqual([{ id: 'optional', status: 'failed' }, { id: 'after', status: 'succeeded' }, { id: 'probe', status: 'succeeded' }, { id: 'only-a', status: 'skipped' }, { id: 'then', status: 'skipped' }]);
  });

  it('cancels a running run: the running step stops, the rest never start', async () => {
    const id = startRun(sys, wf([{ id: 'long', kind: 'noop', with: { sleepMs: 5000 } }, { id: 'next', kind: 'noop', needs: ['long'] }]));
    const p = runWorkflow(sys, id, { runners });
    await new Promise((r) => setTimeout(r, 100));
    cancelRun(sys, id, 'tester');
    const t = Date.now();
    expect((await p).status).toBe('cancelled');
    expect(Date.now() - t).toBeLessThan(1500);
    expect(getRun(sys, id)!.steps.map((s) => s.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('resume after the process is killed', () => {
  it('a run killed mid-step resumes elsewhere: completed steps are not repeated, the interrupted one runs again', async () => {
    const id = startRun(sys, wf([
      { id: 'first', kind: 'noop', with: { value: 1 } },
      { id: 'long', kind: 'noop', needs: ['first'], with: { sleepMs: 30000, value: 2 } },
      { id: 'last', kind: 'noop', needs: ['long'], with: { value: '${steps.long.output}' } },
      { id: 'unsafe', kind: 'noop', needs: ['first'], onInterrupt: 'fail', with: { sleepMs: 30000 } },
    ]));
    const root = path.resolve(__dirname, '..', '..', '..');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'fixtures', 'run-worker.ts'), sys.paths.home, id], { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'), NODE_NO_WARNINGS: '1' }, stdio: 'ignore' });
    const deadline = Date.now() + 30_000;
    while (step(id, 'long').status !== 'running' || step(id, 'unsafe').status !== 'running') {
      if (Date.now() > deadline) throw new Error('worker never reached the long step');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(getRun(sys, id)!.owner).toBe(child.pid);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    // the run still says "running", owned by a process that no longer exists
    expect(getRun(sys, id)!.status).toBe('running');
    const fast: Runners = { noop: async ({ input }) => ({ output: input.value ?? null }) };
    const r = await runWorkflow(sys, id, { runners: fast });
    expect(r.status).toBe('failed'); // only because of the step marked unsafe to repeat
    expect(step(id, 'first').attempts).toBe(1);
    expect(step(id, 'long')).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(step(id, 'long').log.join('\n')).toMatch(/interrupted during attempt 1; will run again/);
    expect(step(id, 'last')).toMatchObject({ status: 'succeeded', output: 2 });
    expect(step(id, 'unsafe')).toMatchObject({ status: 'failed', error: expect.stringMatching(/not safe/) });
    expect(runHistory(sys, id).filter((e) => e.type === 'workflow.step-interrupted').map((e) => e.step).sort()).toEqual(['long', 'unsafe']);
  }, 60_000);

  it('refuses to execute a run another live process is executing', async () => {
    const id = startRun(sys, wf([{ id: 'a', kind: 'noop' }]));
    sys.db.run("UPDATE workflow_runs SET status='running', owner_pid=?, heartbeat_at=? WHERE id=?", process.ppid, new Date().toISOString(), id);
    await expect(runWorkflow(sys, id, { runners })).rejects.toThrow(/being executed by process/);
  });
});

describe('approvals and permissions', () => {
  it('a step that asks for a sensitive permission waits for a person; approval resumes it', async () => {
    const def = wf([
      { id: 'plan', kind: 'noop', with: { value: { target: 'sandbox' } } },
      { id: 'install', kind: 'noop', needs: ['plan'], permissions: ['installation'], with: { value: 'installed' } },
      { id: 'report', kind: 'noop', needs: ['install'] },
    ], { permissions: ['installation'] });
    const id = startRun(sys, def);
    const r1 = await runWorkflow(sys, id, { runners });
    expect(r1.status).toBe('waiting');
    expect(step(id, 'install')).toMatchObject({ status: 'waiting', error: expect.stringMatching(/needs a person's approval.*installation/) });
    expect(step(id, 'plan').status).toBe('succeeded');
    expect(listNotifications(sys, { unreadOnly: true }).filter((n: any) => n.kind === 'workflow.approval')).toHaveLength(1);
    approveStep(sys, id, 'install', { by: 'tester', approve: true, note: 'sandbox only' });
    expect(listNotifications(sys, { unreadOnly: true }).filter((n: any) => n.kind === 'workflow.approval')).toHaveLength(0); // answered, so no longer unread
    const r2 = await runWorkflow(sys, id, { runners });
    expect(r2.status).toBe('succeeded');
    expect(step(id, 'install').approval).toMatchObject({ approved: true, by: 'tester', note: 'sandbox only' });
    expect(step(id, 'plan').attempts).toBe(1);
  });

  it('a rejection fails the step and skips what depends on it; an approval step records who decided', async () => {
    const id = startRun(sys, wf([{ id: 'ask', kind: 'approval', with: { question: 'Go ahead?' } }, { id: 'act', kind: 'noop', needs: ['ask'] }]));
    expect((await runWorkflow(sys, id, { runners })).status).toBe('waiting');
    expect(step(id, 'ask').error).toBe('Go ahead?');
    approveStep(sys, id, 'ask', { by: 'tester', approve: false, note: 'not today' });
    const r = await runWorkflow(sys, id, { runners });
    expect(r.status).toBe('failed');
    expect(step(id, 'ask').error).toBe('rejected by tester: not today');
    expect(step(id, 'act').status).toBe('skipped');
    expect(() => approveStep(sys, id, 'ask', { by: 'x', approve: true })).toThrow(/not waiting/);
  });

  it('never runs a step with a permission the run was not granted', async () => {
    const def = wf([{ id: 'net', kind: 'noop', permissions: ['network'] }], { permissions: ['network'] });
    const r = await runWorkflow(sys, startRun(sys, def, {}, { grant: [] }), { runners });
    expect(step(r.runId, 'net')).toMatchObject({ status: 'failed', error: 'permission not granted to this run: network', attempts: 0 });
    expect(() => startRun(sys, def, {}, { grant: ['network', 'shell'] })).toThrow(/Cannot grant shell/);
  });

  it('API steps must declare what the command needs; queries need nothing', async () => {
    const calls: string[] = [];
    const api = { commands: { 'system.overview': { kind: 'query' as const, title: '' }, 'capabilities.install': { kind: 'action' as const, title: '' }, 'brand.new': { kind: 'action' as const, title: '' } }, call: async (n: string) => (calls.push(n), { ok: n }) };
    const r = await run(wf([
      { id: 'look', kind: 'api-call', with: { command: 'system.overview' } },
      { id: 'sneaky', kind: 'api-call', with: { command: 'capabilities.install', args: { id: 'x' } } },
      { id: 'real', kind: 'api-call', permissions: ['write'], with: { command: 'capabilities.install', args: { id: 'x', real: true } } },
      { id: 'unknown-action', kind: 'api-call', permissions: ['network'], with: { command: 'brand.new' } },
    ], { permissions: ['network', 'write'] }), {}, { 'api-call': apiCallRunner(api) });
    expect(r.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'failed', 'failed']);
    expect(step(r.runId, 'sneaky').error).toMatch(/needs the step to declare: write/); // a sandbox install writes inside the home
    expect(step(r.runId, 'real').error).toMatch(/needs the step to declare: installation/); // a real one changes a host
    expect(step(r.runId, 'unknown-action').error).toMatch(/needs the step to declare: write/);
    expect(calls).toEqual(['system.overview']);
  });

  it('shell steps are off by default and, when on, run only allow-listed programs without a shell', async () => {
    const def = (program: string, args: string[]) => wf([{ id: 'cmd', kind: 'shell', permissions: ['shell'], with: { program, args } }], { permissions: ['shell'] });
    const approveAndRun = async (d: unknown) => {
      const id = startRun(sys, d);
      await runWorkflow(sys, id, { runners });
      approveStep(sys, id, 'cmd', { by: 'tester', approve: true });
      await runWorkflow(sys, id, { runners });
      return step(id, 'cmd');
    };
    expect((await approveAndRun(def('node', ['-e', 'console.log(1)']))).error).toMatch(/shell steps are turned off/);
    setSetting(sys.db, 'workflow.shell', { enabled: true, allow: ['node'] });
    const ok = await approveAndRun(def(process.execPath, ['-e', 'console.log("hi " + (process.env.GITHUB_TOKEN ? "leak" : "clean"))']));
    expect(ok).toMatchObject({ status: 'succeeded', output: { code: 0, stdout: expect.stringMatching(/hi clean/) } });
    expect((await approveAndRun(def('powershell', ['-c', 'echo x']))).error).toMatch(/not in workflow.shell.allow/);
  });
});

it('StepError marks failures that retrying cannot fix', () => {
  expect(new StepError('x', false).retryable).toBe(false);
});
