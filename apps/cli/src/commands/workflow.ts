import fs from 'node:fs';
import type { Command } from 'commander';
import { type Sys, eventsSince } from '@synaptome/core';
import { claudeCliProvider } from '@synaptome/evaluation';
import { agentRunner } from '@synaptome/agents';
import { buildProviders } from '@synaptome/providers';
import { createApi } from '@synaptome/service';
import { type RunView, WorkflowError, approveStep, cancelRun, defaultRunners, findWorkflow, getRun, listRuns, loadWorkflows, runHistory, runWorkflow, startRun, validateWorkflow } from '@synaptome/workflow';
import { CliError, EXIT, action, kv, table } from '../ctx';

async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WorkflowError) throw new CliError(e.message, e.code === 'not-found' ? EXIT.notFound : e.code === 'invalid' ? EXIT.usage : EXIT.blocked, e.hint);
    throw e;
  }
}

const runners = (sys: Sys) => {
  const api = createApi(sys, { origin: 'workflow' });
  return defaultRunners({ api: { call: api.call, commands: api.commands }, model: claudeCliProvider(), agent: agentRunner({ providers: buildProviders(sys) }) });
};

/** A value given on the command line: JSON when it parses (numbers, booleans, lists), otherwise text. */
const parseValue = (v: string) => {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const collect = (v: string, prev: string[]) => [...prev, v];

export function renderRun(v: RunView): string {
  return [
    kv([['run', v.id], ['workflow', `${v.workflowId} v${v.version} — ${v.title}`], ['status', v.status + (v.error ? ` (${v.error})` : '')], ['inputs', JSON.stringify(v.inputs)], ['granted', v.granted.join(', ') || 'none'], ['started', `${v.createdAt.slice(0, 19).replace('T', ' ')} by ${v.startedBy}`]]),
    '',
    table(v.steps.map((s) => ({ step: s.id, kind: s.kind, status: s.status, tries: s.attempts || '', detail: s.error ?? (s.output != null ? JSON.stringify(s.output) : '') })), [{ key: 'step', max: 22 }, { key: 'kind' }, { key: 'status' }, { key: 'tries' }, { key: 'detail', max: 90 }]),
    ...v.steps.filter((s) => s.status === 'waiting').map((s) => `\nwaiting: ${s.id} — ${s.error}\n  approve: synaptome workflow approve ${v.id} ${s.id}\n  reject:  synaptome workflow approve ${v.id} ${s.id} --reject --note "<why>"`),
  ].join('\n');
}

/** Runs to completion in the foreground, printing each step as it changes. */
export async function execute(ctx: { sys: Sys; json: boolean }, runId: string): Promise<RunView> {
  let after = ctx.sys.db.get<{ id: number }>('SELECT MAX(id) id FROM events')?.id ?? 0;
  const print = () => {
    for (const e of eventsSince(ctx.sys.db, after, 200)) {
      after = e.id;
      if (e.subject !== runId || ctx.json) continue;
      const p: any = e.payload ?? {};
      const label = e.type.replace('workflow.', '');
      if (p.step) process.stderr.write(`  ${label.padEnd(18)} ${p.step}${p.attempt > 1 ? ` (attempt ${p.attempt})` : ''}${p.error ? ` — ${p.error}` : ''}${p.reason ? ` — ${p.reason}` : ''}\n`);
    }
  };
  const timer = setInterval(print, 300);
  try {
    await guard(() => runWorkflow(ctx.sys, runId, { runners: runners(ctx.sys) }));
  } finally {
    clearInterval(timer);
    print();
  }
  const v = getRun(ctx.sys, runId)!;
  if (v.status === 'failed') process.exitCode = EXIT.error;
  return v;
}

export function registerWorkflow(program: Command) {
  const wf = program.command('workflow').description('define, run, approve, cancel and resume workflows');

  wf.command('list', { isDefault: true }).description('workflows that can be run').action(
    action((ctx) => {
      const l = loadWorkflows(ctx.sys);
      ctx.out(l, () => [table(l.workflows.map((w) => ({ id: w.def.id, v: w.def.version, from: w.origin, steps: w.def.steps.length, permissions: w.def.permissions.join(','), title: w.def.title })), [{ key: 'id', max: 30 }, { key: 'v' }, { key: 'from' }, { key: 'steps' }, { key: 'permissions', max: 30 }, { key: 'title', max: 50 }]), ...l.problems.map((p) => `\ninvalid, not loaded: ${p.file}\n  ${p.errors.join('\n  ')}`)].join('\n'));
    }),
  );

  wf.command('show <workflowId>').description('steps, inputs and permissions of a workflow').action(
    action((ctx, id: string) => {
      const w = findWorkflow(ctx.sys, id);
      if (!w) throw new CliError(`No workflow "${id}"`, EXIT.notFound, 'list them with: synaptome workflow list');
      const d = w.def;
      ctx.out(d, () => [kv([['workflow', `${d.id} v${d.version}`], ['title', d.title], ['about', d.description], ['permissions', d.permissions.join(', ') || 'none'], ['inputs', Object.entries(d.inputs).map(([k, v]) => `${k} (${v.type}${v.required ? '' : ', optional'})`).join(', ') || 'none']]), '', table(d.steps.map((s) => ({ step: s.id, kind: s.kind, needs: s.needs.join(','), permissions: s.permissions.join(','), title: s.title ?? '' })), [{ key: 'step' }, { key: 'kind' }, { key: 'needs', max: 30 }, { key: 'permissions' }, { key: 'title', max: 50 }])].join('\n'));
    }),
  );

  wf.command('validate <file>').description('check a workflow definition file without running it').action(
    action((ctx, file: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e: any) {
        throw new CliError(`${file}: ${e.message}`, EXIT.usage);
      }
      const v = validateWorkflow(raw);
      if (!v.ok) throw new CliError(`${file} is not a valid workflow:\n  ${v.errors.join('\n  ')}`, EXIT.usage);
      ctx.out({ ok: true, id: v.def.id, steps: v.def.steps.length }, () => `valid: ${v.def.id} (${v.def.steps.length} steps)`);
    }),
  );

  wf.command('run <workflowId>')
    .description('start a workflow and run it in the foreground (steps needing approval pause the run)')
    .option('-i, --input <key=value>', 'an input value (repeatable; JSON values allowed)', collect, [])
    .option('--grant <permissions>', 'grant fewer permissions than the workflow declares (comma-separated)')
    .option('--detach', 'only create the run; execute it later with: synaptome workflow resume <run>')
    .action(
      action(async (ctx, id: string, opts: { input: string[]; grant?: string; detach?: boolean }) => {
        const w = findWorkflow(ctx.sys, id);
        if (!w) throw new CliError(`No workflow "${id}"`, EXIT.notFound, 'list them with: synaptome workflow list');
        const inputs = Object.fromEntries(opts.input.map((kvp) => {
          const i = kvp.indexOf('=');
          if (i < 1) throw new CliError(`--input needs key=value, got "${kvp}"`, EXIT.usage);
          return [kvp.slice(0, i), parseValue(kvp.slice(i + 1))];
        }));
        const grant = opts.grant != null ? opts.grant.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const runId = await guard(() => startRun(ctx.sys, w.def, inputs, { by: 'cli', grant: grant as any }));
        if (!ctx.json) process.stderr.write(`run ${runId} started (${w.def.title})\n`);
        const v = opts.detach ? getRun(ctx.sys, runId)! : await execute(ctx, runId);
        ctx.out(v, () => renderRun(v));
      }),
    );

  wf.command('runs').description('recent workflow runs').option('--status <status>').option('--workflow <id>').action(
    action((ctx, opts: { status?: string; workflow?: string }) => {
      const rows = listRuns(ctx.sys, { status: opts.status, workflowId: opts.workflow });
      ctx.out(rows, () => table(rows.map((r) => ({ ...r, when: r.createdAt.slice(0, 19).replace('T', ' ') })), [{ key: 'id' }, { key: 'workflowId', title: 'workflow', max: 30 }, { key: 'status' }, { key: 'when' }, { key: 'error', max: 60 }]));
    }),
  );

  wf.command('status <runId>').description('one run with every step').action(
    action((ctx, id: string) => {
      const v = getRun(ctx.sys, id);
      if (!v) throw new CliError(`No workflow run "${id}"`, EXIT.notFound, 'list them with: synaptome workflow runs');
      ctx.out(v, () => renderRun(v));
    }),
  );

  wf.command('approve <runId> <stepId>')
    .description('approve (or --reject) a step that is waiting for a person, then continue the run')
    .option('--reject', 'reject instead of approving')
    .option('--note <text>', 'why')
    .option('--no-resume', 'record the decision without continuing the run')
    .action(
      action(async (ctx, id: string, stepId: string, opts: { reject?: boolean; note?: string; resume: boolean }) => {
        await guard(() => approveStep(ctx.sys, id, stepId, { by: 'cli', approve: !opts.reject, note: opts.note }));
        if (!ctx.json) process.stderr.write(`${opts.reject ? 'rejected' : 'approved'} ${stepId}\n`);
        const v = opts.resume ? await execute(ctx, id) : getRun(ctx.sys, id)!;
        ctx.out(v, () => renderRun(v));
      }),
    );

  wf.command('cancel <runId>').description('cancel a run (a running step is stopped)').action(
    action(async (ctx, id: string) => {
      const v = await guard(() => cancelRun(ctx.sys, id, 'cli'));
      ctx.out(v, () => renderRun(v));
    }),
  );

  wf.command('resume <runId>').description('continue a run: after a crash, a restart or an approval (completed steps are not repeated)').action(
    action(async (ctx, id: string) => {
      if (!getRun(ctx.sys, id)) throw new CliError(`No workflow run "${id}"`, EXIT.notFound);
      const v = await execute(ctx, id);
      ctx.out(v, () => renderRun(v));
    }),
  );

  wf.command('history <runId>').description('everything that happened in a run, in order').action(
    action((ctx, id: string) => {
      const h = runHistory(ctx.sys, id);
      ctx.out(h, () => table(h.map((e) => ({ at: String(e.ts).slice(11, 23), event: e.type.replace('workflow.', ''), step: e.step ?? '', detail: e.error ?? e.reason ?? e.status ?? (e.by ? `by ${e.by}` : '') })), [{ key: 'at' }, { key: 'event' }, { key: 'step' }, { key: 'detail', max: 80 }]));
    }),
  );
}
