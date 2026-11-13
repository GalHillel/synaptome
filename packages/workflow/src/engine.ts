import { type Sys, emit, notify, nowIso, pj, shortHash } from '@synaptome/core';
import { type Permission, type Scope, type StepDefinition, type StepKind, type WorkflowDefinition, checkContract, evalWhen, resolveTemplates, validateInputs, validateWorkflow } from './definition';

/* =====================================================================
 * Workflow engine. Runs live in SQLite (schema v5): the definition is frozen into the run at start, and every
 * completed step's output is stored as it finishes, so a run killed at any point resumes from its last completed
 * step. Steps run as soon as the steps they need have succeeded, up to a parallel limit.
 * ===================================================================== */

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export interface Approval {
  approved: boolean;
  by: string;
  note: string;
  at: string;
}
export interface StepContext {
  sys: Sys;
  runId: string;
  step: StepDefinition;
  attempt: number;
  input: Record<string, unknown>;
  signal: AbortSignal;
  approval: Approval | null;
  log(line: string): void;
}
/** A step either produces output, or says it is waiting (for a person, for example). */
export type StepOutcome = { output?: unknown } | { waiting: string };
export type StepRunner = (ctx: StepContext) => Promise<StepOutcome>;
export type Runners = Partial<Record<StepKind, StepRunner>>;

/** A step failure. `retryable: false` skips the remaining retries (bad input, permission, broken contract). */
export class StepError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
  }
}
export class WorkflowError extends Error {
  constructor(public code: 'invalid' | 'not-found' | 'busy' | 'state', message: string, public hint?: string) {
    super(message);
  }
}

const TERMINAL_RUN: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
const TERMINAL_STEP: StepStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];
const alive = (pid: number | null | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
};
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/* ---------- start ---------- */

export function startRun(sys: Sys, raw: unknown, inputs: Record<string, unknown> = {}, opts: { by?: string; grant?: Permission[] } = {}): string {
  const v = validateWorkflow(raw);
  if (!v.ok) throw new WorkflowError('invalid', `Workflow definition is invalid:\n  ${v.errors.join('\n  ')}`);
  const def = v.def;
  const iv = validateInputs(def, inputs);
  if (iv.errors.length) throw new WorkflowError('invalid', `Inputs are invalid:\n  ${iv.errors.join('\n  ')}`);
  const grant = opts.grant ?? def.permissions;
  const beyond = grant.filter((p) => !def.permissions.includes(p));
  if (beyond.length) throw new WorkflowError('invalid', `Cannot grant ${beyond.join(', ')}: the workflow does not declare ${beyond.length > 1 ? 'them' : 'it'}`);
  const id = `wr-${shortHash(`${def.id}|${Date.now()}|${process.pid}|${Math.random()}`, 10)}`;
  const now = nowIso();
  sys.db.tx(() => {
    sys.db.run('INSERT INTO workflow_runs (id, workflow_id, workflow_version, definition, inputs, granted, status, started_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, def.id, def.version, JSON.stringify(def), JSON.stringify(iv.values), JSON.stringify(grant), 'queued', opts.by ?? 'user', now, now);
    for (const s of def.steps) sys.db.run("INSERT INTO step_runs (run_id, step_id, status) VALUES (?,?,'pending')", id, s.id);
  });
  emit(sys.db, 'workflow.run-started', id, { workflowId: def.id, version: def.version, inputs: iv.values, granted: grant, by: opts.by ?? 'user' });
  return id;
}

/* ---------- reading ---------- */

export interface StepView {
  id: string;
  title: string;
  kind: StepKind;
  needs: string[];
  permissions: Permission[];
  status: StepStatus;
  attempts: number;
  input: unknown;
  output: unknown;
  error: string | null;
  log: string[];
  approval: Approval | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RunView {
  id: string;
  workflowId: string;
  version: string | null;
  title: string;
  status: RunStatus;
  error: string | null;
  inputs: Record<string, unknown>;
  granted: Permission[];
  startedBy: string | null;
  owner: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  steps: StepView[];
}

const runRow = (sys: Sys, runId: string) => sys.db.get<any>('SELECT * FROM workflow_runs WHERE id=?', runId);
const stepRows = (sys: Sys, runId: string) => new Map(sys.db.all<any>('SELECT * FROM step_runs WHERE run_id=?', runId).map((r) => [r.step_id as string, r]));

export function getRun(sys: Sys, runId: string): RunView | null {
  const r = runRow(sys, runId);
  if (!r) return null;
  const def: WorkflowDefinition = JSON.parse(r.definition);
  const rows = stepRows(sys, runId);
  return {
    id: r.id, workflowId: r.workflow_id, version: r.workflow_version, title: def.title, status: r.status, error: r.error,
    inputs: pj(r.inputs, {}), granted: pj(r.granted, []), startedBy: r.started_by, owner: r.owner_pid, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
    steps: def.steps.map((s) => {
      const x = rows.get(s.id) ?? {};
      return { id: s.id, title: s.title ?? s.id, kind: s.kind, needs: s.needs, permissions: s.permissions, status: x.status, attempts: x.attempts ?? 0, input: pj(x.input, null), output: pj(x.output, null), error: x.error ?? null, log: pj(x.log, []), approval: pj(x.approval, null), startedAt: x.started_at ?? null, finishedAt: x.finished_at ?? null };
    }),
  };
}

export function listRuns(sys: Sys, f: { status?: string; workflowId?: string; limit?: number } = {}) {
  const where = [f.status ? 'status = ?' : '1', f.workflowId ? 'workflow_id = ?' : '1'].join(' AND ');
  return sys.db.all<any>(`SELECT id, workflow_id, workflow_version, status, error, started_by, created_at, updated_at, finished_at FROM workflow_runs WHERE ${where} ORDER BY created_at DESC LIMIT ?`, ...[f.status, f.workflowId].filter(Boolean), f.limit ?? 50).map((r) => ({ id: r.id, workflowId: r.workflow_id, version: r.workflow_version, status: r.status as RunStatus, error: r.error, startedBy: r.started_by, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at }));
}

/** Everything that happened in a run, in order: the run is reconstructable from this alone. */
export function runHistory(sys: Sys, runId: string) {
  return sys.db.all<any>("SELECT id, ts, type, payload FROM events WHERE subject=? AND type LIKE 'workflow.%' ORDER BY id", runId).map((e) => ({ id: e.id, ts: e.ts, type: e.type, ...pj<any>(e.payload, {}) }));
}

/* ---------- person-facing controls ---------- */

export function approveStep(sys: Sys, runId: string, stepId: string, opts: { by: string; approve: boolean; note?: string }) {
  const run = runRow(sys, runId);
  if (!run) throw new WorkflowError('not-found', `No workflow run "${runId}"`);
  const row = stepRows(sys, runId).get(stepId);
  if (!row) throw new WorkflowError('not-found', `Run ${runId} has no step "${stepId}"`);
  if (row.status !== 'waiting') throw new WorkflowError('state', `Step "${stepId}" is ${row.status}, not waiting for approval`);
  const approval: Approval = { approved: opts.approve, by: opts.by, note: opts.note ?? '', at: nowIso() };
  sys.db.tx(() => {
    if (opts.approve) sys.db.run("UPDATE step_runs SET status='pending', error=NULL, approval=? WHERE run_id=? AND step_id=?", JSON.stringify(approval), runId, stepId);
    else sys.db.run("UPDATE step_runs SET status='failed', error=?, approval=?, finished_at=? WHERE run_id=? AND step_id=?", `rejected by ${opts.by}${opts.note ? `: ${opts.note}` : ''}`, JSON.stringify(approval), nowIso(), runId, stepId);
    if (run.status === 'waiting') sys.db.run("UPDATE workflow_runs SET status='queued', updated_at=? WHERE id=?", nowIso(), runId);
    // The request has been answered: it no longer needs anyone's attention.
    sys.db.run('UPDATE notifications SET read_at=? WHERE dedupe_key=? AND read_at IS NULL', nowIso(), `workflow-approval:${runId}:${stepId}`);
  });
  emit(sys.db, opts.approve ? 'workflow.step-approved' : 'workflow.step-rejected', runId, { step: stepId, by: opts.by, note: opts.note ?? '' });
  return getRun(sys, runId)!;
}

export function cancelRun(sys: Sys, runId: string, by = 'user') {
  const run = runRow(sys, runId);
  if (!run) throw new WorkflowError('not-found', `No workflow run "${runId}"`);
  if (TERMINAL_RUN.includes(run.status)) throw new WorkflowError('state', `Run ${runId} already ${run.status}`);
  sys.db.run('UPDATE workflow_runs SET cancel_requested=1, updated_at=? WHERE id=?', nowIso(), runId);
  emit(sys.db, 'workflow.cancel-requested', runId, { by });
  // No live process is executing it: finish the cancellation here. Otherwise the running process sees the flag.
  const owned = run.status === 'running' && alive(run.owner_pid) && run.owner_pid !== process.pid;
  if (!owned && !active.has(runId)) finishCancelled(sys, runId);
  return getRun(sys, runId)!;
}

function finishCancelled(sys: Sys, runId: string) {
  const now = nowIso();
  sys.db.tx(() => {
    sys.db.run("UPDATE step_runs SET status='cancelled', finished_at=? WHERE run_id=? AND status IN ('pending','running','waiting')", now, runId);
    sys.db.run("UPDATE workflow_runs SET status='cancelled', owner_pid=NULL, finished_at=?, updated_at=? WHERE id=?", now, now, runId);
    sys.db.run('UPDATE notifications SET read_at=? WHERE dedupe_key LIKE ? AND read_at IS NULL', now, `workflow-approval:${runId}:%`);
  });
  emit(sys.db, 'workflow.run-finished', runId, { status: 'cancelled' });
}

/* ---------- execution ---------- */

const active = new Set<string>();

function claim(sys: Sys, runId: string): 'go' | 'done' {
  return sys.db.tx(() => {
    const r = runRow(sys, runId);
    if (!r) throw new WorkflowError('not-found', `No workflow run "${runId}"`);
    if (TERMINAL_RUN.includes(r.status)) return 'done';
    const fresh = r.heartbeat_at && Date.now() - Date.parse(r.heartbeat_at) < 30_000;
    if (r.status === 'running' && r.owner_pid && r.owner_pid !== process.pid && alive(r.owner_pid) && fresh) throw new WorkflowError('busy', `Run ${runId} is being executed by process ${r.owner_pid}`);
    sys.db.run("UPDATE workflow_runs SET status='running', owner_pid=?, heartbeat_at=?, updated_at=? WHERE id=?", process.pid, nowIso(), nowIso(), runId);
    return 'go';
  });
}

/** Steps left "running" by a process that died: retried, or failed when repeating them is not safe. */
function recoverInterrupted(sys: Sys, runId: string, def: WorkflowDefinition) {
  for (const [id, row] of stepRows(sys, runId)) {
    if (row.status !== 'running') continue;
    const s = def.steps.find((x) => x.id === id)!;
    const log = [...pj<string[]>(row.log, []), `${nowIso()} interrupted during attempt ${row.attempts}; ${s.onInterrupt === 'retry' ? 'will run again' : 'not repeated automatically'}`];
    if (s.onInterrupt === 'retry') sys.db.run("UPDATE step_runs SET status='pending', log=? WHERE run_id=? AND step_id=?", JSON.stringify(log), runId, id);
    else sys.db.run("UPDATE step_runs SET status='failed', error=?, log=?, finished_at=? WHERE run_id=? AND step_id=?", 'interrupted while running; repeating it automatically is not safe (onInterrupt: fail)', JSON.stringify(log), nowIso(), runId, id);
    emit(sys.db, 'workflow.step-interrupted', runId, { step: id, attempt: row.attempts, action: s.onInterrupt });
  }
}

function setStep(sys: Sys, runId: string, stepId: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  sys.db.run(`UPDATE step_runs SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE run_id=? AND step_id=?`, ...keys.map((k) => fields[k]), runId, stepId);
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  steps: { id: string; status: StepStatus }[];
}

/**
 * Executes (or resumes) a run until it finishes, waits for a person, or is cancelled. Safe to call again at any time:
 * completed steps are never repeated.
 */
export async function runWorkflow(sys: Sys, runId: string, opts: { runners: Runners; maxParallel?: number; signal?: AbortSignal }): Promise<RunSummary> {
  if (active.has(runId)) throw new WorkflowError('busy', `Run ${runId} is already executing in this process`);
  if (claim(sys, runId) === 'done') return summary(sys, runId);
  active.add(runId);
  const run = runRow(sys, runId);
  const def: WorkflowDefinition = JSON.parse(run.definition);
  const granted: Permission[] = pj(run.granted, []);
  const inputs = pj<Record<string, unknown>>(run.inputs, {});
  const settings = sys.settings().workflow;
  const maxParallel = Math.max(1, opts.maxParallel ?? settings.maxParallel);
  const running = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  let beats = 0;
  const watcher = setInterval(() => {
    // cancellation can be requested by another process; the heartbeat proves this one is alive
    if (runRow(sys, runId)?.cancel_requested || opts.signal?.aborted) for (const r of running.values()) r.controller.abort('cancelled');
    if (++beats % 10 === 0) sys.db.run('UPDATE workflow_runs SET heartbeat_at=? WHERE id=?', nowIso(), runId);
  }, 250);
  watcher.unref?.();
  try {
    recoverInterrupted(sys, runId, def);
    for (;;) {
      const cancel = !!runRow(sys, runId).cancel_requested || !!opts.signal?.aborted;
      if (cancel) {
        for (const r of running.values()) r.controller.abort('cancelled');
        await Promise.allSettled([...running.values()].map((r) => r.promise));
        finishCancelled(sys, runId);
        break;
      }
      const rows = stepRows(sys, runId);
      const scope: Scope = { inputs, steps: Object.fromEntries([...rows].map(([id, r]) => [id, { status: r.status, output: pj(r.output, null) }])) };
      let progressed = false;
      for (const s of def.steps) {
        const row = rows.get(s.id);
        if (row.status !== 'pending' || running.has(s.id)) continue;
        const needs = s.needs.map((n) => ({ def: def.steps.find((x) => x.id === n)!, row: rows.get(n) }));
        const satisfied = (n: (typeof needs)[number]) => n.row.status === 'succeeded' || (n.row.status === 'failed' && n.def.continueOnError) || (n.row.status === 'skipped' && s.ifNeedsSkipped === 'run');
        const broken = needs.find((n) => TERMINAL_STEP.includes(n.row.status) && !satisfied(n));
        if (broken) {
          setStep(sys, runId, s.id, { status: 'skipped', error: `needs "${broken.def.id}", which ${broken.row.status === 'skipped' ? 'was skipped' : broken.row.status}`, finished_at: nowIso() });
          emit(sys.db, 'workflow.step-skipped', runId, { step: s.id, reason: 'dependency' });
          progressed = true;
          continue;
        }
        if (!needs.every(satisfied)) continue;
        if (s.when && !evalWhen(s.when, scope)) {
          setStep(sys, runId, s.id, { status: 'skipped', error: `condition not met (${s.when.path})`, finished_at: nowIso() });
          emit(sys.db, 'workflow.step-skipped', runId, { step: s.id, reason: 'condition' });
          progressed = true;
          continue;
        }
        const missing = s.permissions.filter((p) => !granted.includes(p));
        if (missing.length) {
          setStep(sys, runId, s.id, { status: 'failed', error: `permission not granted to this run: ${missing.join(', ')}`, finished_at: nowIso() });
          emit(sys.db, 'workflow.step-failed', runId, { step: s.id, error: 'permission not granted', missing });
          progressed = true;
          continue;
        }
        const approval = pj<Approval | null>(row.approval, null);
        const sensitive = s.permissions.filter((p) => settings.approvalRequiredFor.includes(p));
        if (sensitive.length && !approval?.approved) {
          const reason = `needs a person's approval before it runs (permissions: ${sensitive.join(', ')})`;
          setStep(sys, runId, s.id, { status: 'waiting', error: reason });
          emit(sys.db, 'workflow.approval-requested', runId, { step: s.id, permissions: sensitive });
          notify(sys, { level: 'action', kind: 'workflow.approval', subject: runId, title: `Approve step "${s.title ?? s.id}" of ${def.title}?`, body: `${reason}. Approve with: synaptome workflow approve ${runId} ${s.id}`, dedupeKey: `workflow-approval:${runId}:${s.id}` });
          progressed = true;
          continue;
        }
        if (running.size >= maxParallel) continue;
        const controller = new AbortController();
        const promise = executeStep(sys, runId, def, s, scope, opts.runners, controller, approval).finally(() => running.delete(s.id));
        running.set(s.id, { promise, controller });
        progressed = true;
      }
      if (running.size) {
        await Promise.race([...running.values()].map((r) => r.promise));
        continue;
      }
      if (progressed) continue;
      const after = [...stepRows(sys, runId).values()];
      if (after.some((r) => r.status === 'waiting')) {
        sys.db.run("UPDATE workflow_runs SET status='waiting', owner_pid=NULL, updated_at=? WHERE id=?", nowIso(), runId);
        emit(sys.db, 'workflow.run-waiting', runId, { steps: after.filter((r) => r.status === 'waiting').map((r) => r.step_id) });
        break;
      }
      const failed = after.filter((r) => r.status === 'failed' && !def.steps.find((s) => s.id === r.step_id)!.continueOnError);
      const stuck = after.filter((r) => !TERMINAL_STEP.includes(r.status));
      const status: RunStatus = failed.length || stuck.length ? 'failed' : 'succeeded';
      const error = failed.length ? `step${failed.length > 1 ? 's' : ''} failed: ${failed.map((r) => r.step_id).join(', ')}` : stuck.length ? `no step could run: ${stuck.map((r) => r.step_id).join(', ')}` : null;
      const now = nowIso();
      sys.db.run('UPDATE workflow_runs SET status=?, error=?, owner_pid=NULL, finished_at=?, updated_at=? WHERE id=?', status, error, now, now, runId);
      emit(sys.db, 'workflow.run-finished', runId, { status, error });
      break;
    }
  } finally {
    clearInterval(watcher);
    active.delete(runId);
  }
  return summary(sys, runId);
}

function summary(sys: Sys, runId: string): RunSummary {
  const v = getRun(sys, runId)!;
  return { runId, status: v.status, steps: v.steps.map((s) => ({ id: s.id, status: s.status })) };
}

async function executeStep(sys: Sys, runId: string, def: WorkflowDefinition, s: StepDefinition, scope: Scope, runners: Runners, controller: AbortController, approval: Approval | null): Promise<void> {
  // Everything before the first await runs synchronously, so the step is marked running before another is chosen.
  const input = resolveTemplates(s.with, scope) as Record<string, unknown>;
  const row = stepRows(sys, runId).get(s.id);
  const firstAttempt = (row.attempts ?? 0) + 1;
  setStep(sys, runId, s.id, { status: 'running', input: JSON.stringify(input), error: null, started_at: row.started_at ?? nowIso() });
  const log = (line: string) => {
    const cur = pj<string[]>(stepRows(sys, runId).get(s.id)?.log, []);
    setStep(sys, runId, s.id, { log: JSON.stringify([...cur, `${nowIso()} ${line}`].slice(-200)) });
  };
  const runner = runners[s.kind];
  const fail = (message: string, attempt: number) => {
    setStep(sys, runId, s.id, { status: 'failed', error: message, finished_at: nowIso() });
    emit(sys.db, 'workflow.step-failed', runId, { step: s.id, attempt, error: message });
  };
  if (!runner) return fail(`no runner is available for steps of kind "${s.kind}"`, firstAttempt);
  const timeoutMs = s.timeoutMs ?? sys.settings().workflow.defaultTimeoutMs;
  const tries = (s.retry?.max ?? 0) + 1;
  for (let n = 1; n <= tries; n++) {
    const attempt = firstAttempt + n - 1;
    setStep(sys, runId, s.id, { attempts: attempt });
    emit(sys.db, 'workflow.step-started', runId, { step: s.id, kind: s.kind, attempt });
    const ac = new AbortController();
    const relay = () => ac.abort(controller.signal.reason);
    controller.signal.addEventListener('abort', relay, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort('timeout');
        reject(new StepError(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      ac.signal.addEventListener('abort', () => reject(new StepError(ac.signal.reason === 'timeout' ? `timed out after ${timeoutMs} ms` : 'cancelled', false)), { once: true });
    });
    try {
      const out = await Promise.race([runner({ sys, runId, step: s, attempt, input, signal: ac.signal, approval, log }), stop]);
      if ('waiting' in out) {
        setStep(sys, runId, s.id, { status: 'waiting', error: out.waiting });
        emit(sys.db, 'workflow.step-waiting', runId, { step: s.id, reason: out.waiting });
        return;
      }
      const broken = checkContract(out.output, s.output);
      if (broken.length) throw new StepError(`output contract violated: ${broken.join('; ')}`, false);
      setStep(sys, runId, s.id, { status: 'succeeded', output: JSON.stringify(out.output ?? null), error: null, finished_at: nowIso() });
      emit(sys.db, 'workflow.step-succeeded', runId, { step: s.id, attempt });
      return;
    } catch (e: any) {
      if (controller.signal.aborted) {
        setStep(sys, runId, s.id, { status: 'cancelled', error: 'cancelled', finished_at: nowIso() });
        emit(sys.db, 'workflow.step-cancelled', runId, { step: s.id, attempt });
        return;
      }
      const message = e?.message ?? String(e);
      const retryable = !(e instanceof StepError) || e.retryable;
      if (!retryable || n === tries) return fail(message, attempt);
      const wait = (s.retry?.backoffMs ?? 1000) * 2 ** (n - 1);
      log(`attempt ${attempt} failed (${message}); retrying in ${wait} ms`);
      emit(sys.db, 'workflow.step-retrying', runId, { step: s.id, attempt, error: message, waitMs: wait });
      try {
        await sleep(wait, controller.signal);
      } catch {
        setStep(sys, runId, s.id, { status: 'cancelled', error: 'cancelled', finished_at: nowIso() });
        return;
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', relay);
    }
  }
}
