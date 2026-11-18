import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killProcessTree, tempSystem, treeKillable } from '@synaptome/core';
import { claudeCliProvider } from '@synaptome/evaluation';
import { type Runners, type StepRunner, getRun, runWorkflow, startRun } from '../src/index';

// Cancellation and timeouts must actually stop work (plan NG, M1; audit W1-W3): the whole process tree ends, and a
// retry never runs while the previous attempt is still going.
let sys: ReturnType<typeof tempSystem>;
const tmp: string[] = [];
beforeEach(() => {
  sys = tempSystem();
});
afterEach(() => {
  sys.dispose();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, ms = 5000) => {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

/** A program that starts a long-running grandchild, writes the grandchild's pid to a file, then waits. */
function treeScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-tree-'));
  tmp.push(dir);
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'tree.cjs');
  fs.writeFileSync(script, `const { spawn } = require('node:child_process');\nconst g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));\nsetTimeout(() => {}, 120000);\n`);
  return { script, pidFile };
}

describe('process trees', () => {
  it('killProcessTree ends the child and the processes it started', async () => {
    const { script, pidFile } = treeScript();
    // Through a shell on Windows, as the headless Claude Code provider runs `claude.cmd`.
    const child = process.platform === 'win32' ? spawn(`"${process.execPath}" "${script}"`, { shell: true, windowsHide: true }) : spawn(process.execPath, [script], { ...treeKillable });
    expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);
    killProcessTree(child);
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  }, 20_000);

  it('a cancelled headless model call stops its whole process tree and reports "cancelled"', async () => {
    const { script, pidFile } = treeScript();
    // The provider runs `<bin> <args>`; a small Node program stands in for the claude CLI.
    const provider = claudeCliProvider({ bin: `node ${script}` });
    const ac = new AbortController();
    const call = provider.complete({ prompt: 'hello', signal: ac.signal, timeoutMs: 60_000 });
    expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    ac.abort();
    const r = await call;
    expect(r).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  }, 30_000);
});

describe('retries', () => {
  it('a retry after a timeout waits until the previous attempt has really ended', async () => {
    let running = 0;
    let maxRunning = 0;
    // An attempt that ignores its abort signal for a while after the step times out.
    const slow: StepRunner = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 400));
      running--;
      throw new Error('too slow');
    };
    const runners: Runners = { noop: slow };
    const runId = startRun(sys, { id: 't.retry', title: 'retry', steps: [{ id: 'a', kind: 'noop', timeoutMs: 100, retry: { max: 2, backoffMs: 10 } }] }, {});
    await runWorkflow(sys, runId, { runners });
    expect(getRun(sys, runId)!.steps[0].status).toBe('failed');
    expect(maxRunning).toBe(1);
  }, 20_000);
});
