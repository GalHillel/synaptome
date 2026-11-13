import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ModelProvider } from '@synaptome/core';
import type { Permission } from './definition';
import { type Runners, type StepRunner, StepError } from './engine';

/** Passes its input through as output, after an optional delay. Useful for joining branches and in tests. */
export const noopRunner: StepRunner = async ({ input, signal }) => {
  const ms = Number(input.sleepMs ?? 0);
  if (ms > 0)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
    });
  if (input.fail) throw new StepError(String(input.fail), input.retryable !== false);
  return { output: input.value !== undefined ? input.value : input };
};

/** Waits until a person approves; the approval itself becomes the step's output. */
export const approvalRunner: StepRunner = async ({ approval, input }) => {
  if (!approval) return { waiting: String(input.question ?? 'waiting for a person to approve') };
  return { output: { approved: approval.approved, by: approval.by, note: approval.note, at: approval.at } };
};

/**
 * Permissions an API action needs from the step that calls it. Queries need none. An action not listed here needs
 * "write", so a new action can never be reached by a step that only declared read access.
 */
export const ACTION_PERMISSIONS: Record<string, Permission[] | ((args: any) => Permission[])> = {
  // A sandbox install stays inside the Synaptome home; a real one changes a host.
  'capabilities.install': (a) => (a?.real ? ['installation'] : ['write']),
  'installations.rollback': ['installation'],
  'installations.uninstall': ['installation', 'delete'],
  'capabilities.approve': ['configuration'],
  'capabilities.reject': ['configuration'],
  'scan.run': ['network'],
  'candidates.evaluate': ['network'],
  'queue.evaluateNext': ['network'],
  'updates.check': ['network'],
  'updates.apply': ['network', 'write'],
  'sources.check': ['network'],
  'sources.setEnabled': ['configuration'],
  'sources.setBudget': ['configuration'],
  'settings.set': ['configuration'],
  'forge.new': ['write'],
  'forge.author': ['api'],
  'forge.check': ['write'],
  'forge.decide': ['configuration'],
};
export function permissionsFor(command: string, kind: 'query' | 'action', args: unknown): Permission[] {
  if (kind === 'query') return [];
  const p = ACTION_PERMISSIONS[command];
  return typeof p === 'function' ? p(args) : (p ?? ['write']);
}

export interface ApiLike {
  call(name: string, args?: unknown): Promise<any>;
  commands: Record<string, { kind: 'query' | 'action'; title: string }>;
}

/** Calls one Synaptome API command; the step must declare the permissions that command needs. */
export function apiCallRunner(api: ApiLike): StepRunner {
  return async ({ input, step }) => {
    const name = String(input.command ?? '');
    const cmd = api.commands[name];
    if (!cmd) throw new StepError(`unknown API command "${name}"`, false);
    const needed = permissionsFor(name, cmd.kind, input.args);
    const missing = needed.filter((p) => !step.permissions.includes(p));
    if (missing.length) throw new StepError(`"${name}" needs the step to declare: ${missing.join(', ')}`, false);
    try {
      return { output: await api.call(name, input.args ?? {}) };
    } catch (e: any) {
      // Domain refusals (not found, not approved, conflict) do not improve by retrying.
      throw new StepError(e?.message ?? String(e), e?.status ? e.status >= 500 : true);
    }
  };
}

/** Asks a model. The step must declare "api" (text leaves the machine to a provider). */
export function modelRunner(provider: ModelProvider): StepRunner {
  return async ({ input, step, signal }) => {
    if (!step.permissions.includes('api')) throw new StepError('a model step must declare the "api" permission', false);
    const prompt = String(input.prompt ?? '');
    if (!prompt) throw new StepError('a model step needs a prompt', false);
    if (signal.aborted) throw new StepError('cancelled', false);
    const r = await provider.complete({ prompt, system: input.system ? String(input.system) : undefined, timeoutMs: input.timeoutMs ? Number(input.timeoutMs) : undefined });
    if (!r.ok) throw new StepError(r.error ?? 'model call failed');
    return { output: { text: r.text, ms: r.ms, provider: provider.id } };
  };
}

/**
 * Runs one program, never through a shell. Off unless `workflow.shell.enabled`, and then only for programs named in
 * `workflow.shell.allow`. Runs in the Synaptome home with a minimal environment (no inherited secrets).
 */
export const shellRunner: StepRunner = async ({ sys, input, signal }) => {
  const cfg = sys.settings().workflow.shell;
  if (!cfg.enabled) throw new StepError('shell steps are turned off (setting workflow.shell.enabled)', false);
  const program = String(input.program ?? '');
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const base = path.basename(program).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!program || !cfg.allow.map((a) => a.toLowerCase()).includes(base)) throw new StepError(`program "${program}" is not in workflow.shell.allow`, false);
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOME: sys.home, USERPROFILE: sys.home };
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: sys.home, env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const cap = (s: string, d: Buffer) => (s.length < 65_536 ? s + d.toString('utf8') : s);
    child.stdout.on('data', (d) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d) => (stderr = cap(stderr, d)));
    signal.addEventListener('abort', () => child.kill(), { once: true });
    child.on('error', (e) => reject(new StepError(`could not start ${program}: ${e.message}`, false)));
    child.on('close', (code) => (code === 0 ? resolve({ output: { code, stdout: stdout.slice(0, 65_536), stderr: stderr.slice(0, 65_536) } }) : reject(new StepError(`${program} exited with code ${code}: ${stderr.slice(0, 400)}`))));
  });
};

export function defaultRunners(opts: { api?: ApiLike; model?: ModelProvider; agent?: StepRunner } = {}): Runners {
  return {
    noop: noopRunner,
    approval: approvalRunner,
    shell: shellRunner,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.api ? { 'api-call': apiCallRunner(opts.api) } : {}),
    ...(opts.model ? { model: modelRunner(opts.model) } : {}),
  };
}
