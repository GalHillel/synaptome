import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type EvalCase, type EvalCaseResult, type EvaluationRunner, type ModelProvider, type Sys, emit, j, nowIso, pj } from '@synaptome/core';

/* ---------- deterministic grading ---------- */

const rx = (p: string) => {
  try {
    return new RegExp(p, 'is');
  } catch {
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'is');
  }
};

/** Every `must` pattern has to match and no `mustNot` pattern may match. No model is involved in grading. */
export function gradeOutput(c: EvalCase, output: string): { passed: boolean; detail: string } {
  const missing = c.must.filter((p) => !rx(p).test(output));
  const forbidden = (c.mustNot ?? []).filter((p) => rx(p).test(output));
  const passed = !missing.length && !forbidden.length && output.trim().length > 0;
  return { passed, detail: passed ? `all ${c.must.length} required pattern(s) present` : [missing.length ? `missing: ${missing.join(' | ')}` : '', forbidden.length ? `forbidden present: ${forbidden.join(' | ')}` : '', output.trim() ? '' : 'empty output'].filter(Boolean).join('; ') };
}

export interface VariantSummary {
  variant: string;
  passed: number;
  total: number;
  passRate: number;
}
export interface EvalSummary {
  cases: number;
  variants: VariantSummary[];
  /** with-skill pass rate minus baseline pass rate, when both variants exist. */
  lift: number | null;
  note: string;
}

export function summarize(results: EvalCaseResult[], cases: number): EvalSummary {
  const by = new Map<string, EvalCaseResult[]>();
  for (const r of results) by.set(r.variant, [...(by.get(r.variant) ?? []), r]);
  const variants = [...by.entries()].map(([variant, rs]) => ({ variant, passed: rs.filter((r) => r.passed).length, total: rs.length, passRate: rs.length ? rs.filter((r) => r.passed).length / rs.length : 0 }));
  const base = variants.find((v) => v.variant === 'baseline');
  const withSkill = variants.find((v) => v.variant === 'with-skill');
  const lift = base && withSkill ? Number((withSkill.passRate - base.passRate).toFixed(3)) : null;
  return { cases, variants, lift, note: `n=${cases} case(s) per variant; deterministic regex grading; a sample this small shows direction, not statistical significance` };
}

export function recordEval(sys: Sys, subjectId: string, suite: string, runner: string, status: 'completed' | 'blocked', results: unknown, summary: unknown): number {
  const id = Number(sys.db.run('INSERT INTO eval_runs (subject_id, suite, runner, status, results, summary, created_at) VALUES (?,?,?,?,?,?,?)', subjectId, suite, runner, status, j(results), j(summary), nowIso()).lastInsertRowid);
  emit(sys.db, status === 'completed' ? 'evaluation.completed' : 'evaluation.blocked', subjectId, { evalId: id, suite, runner });
  return id;
}
export function listEvals(sys: Sys, subjectId?: string, limit = 50) {
  return sys.db
    .all<any>(`SELECT * FROM eval_runs ${subjectId ? 'WHERE subject_id = ?' : ''} ORDER BY id DESC LIMIT ?`, ...(subjectId ? [subjectId] : []), limit)
    .map((r) => ({ id: r.id as number, subjectId: r.subject_id as string, suite: r.suite as string, runner: r.runner as string, status: r.status as string, results: pj<any[]>(r.results, []), summary: pj<any>(r.summary, {}), createdAt: r.created_at as string }));
}

/* ---------- runners ---------- */

/** Runs every case against every variant through a model provider. Reports `blocked` (never a fake pass) when the provider is unavailable. */
export function modelRunner(provider: ModelProvider): EvaluationRunner {
  return {
    id: `model:${provider.id}`,
    async run({ cases, variants }) {
      const avail = await provider.availability();
      if (!avail.available || !avail.authenticated) return { status: 'blocked', blocker: `${provider.title}: ${avail.detail}`, results: [] };
      const results: EvalCaseResult[] = [];
      for (const v of variants) {
        for (const c of cases) {
          // One retry for a transient failure (a stalled or timed-out call); a second failure blocks the run, never a fake pass.
          let r = await provider.complete({ prompt: c.prompt, system: v.system });
          if (!r.ok) r = await provider.complete({ prompt: c.prompt, system: v.system });
          if (!r.ok) return { status: 'blocked', blocker: `${provider.title} failed twice on case ${c.id}: ${r.error}`, results };
          const g = gradeOutput(c, r.text);
          results.push({ caseId: c.id, variant: v.id, passed: g.passed, detail: g.detail, ms: r.ms });
        }
      }
      return { status: 'completed', results };
    },
  };
}

/**
 * Grades outputs that were produced outside Synaptome (for example by a host agent) and saved as
 * <dir>/<variant>/<caseId>.md. The runner id states this origin so results are never mistaken for
 * outputs Synaptome generated itself.
 */
export function importedRunner(dir: string, producedBy: string): EvaluationRunner {
  return {
    id: `imported:${producedBy}`,
    async run({ cases, variants }) {
      const results: EvalCaseResult[] = [];
      const missing: string[] = [];
      for (const v of variants) {
        for (const c of cases) {
          const file = path.join(dir, v.id, `${c.id}.md`);
          if (!fs.existsSync(file)) {
            missing.push(`${v.id}/${c.id}.md`);
            continue;
          }
          const g = gradeOutput(c, fs.readFileSync(file, 'utf8'));
          results.push({ caseId: c.id, variant: v.id, passed: g.passed, detail: g.detail });
        }
      }
      if (missing.length) return { status: 'blocked', blocker: `missing transcript(s): ${missing.slice(0, 6).join(', ')}`, results };
      return { status: 'completed', results };
    },
  };
}

/* ---------- model provider: headless Claude Code ---------- */

/** Working folders of headless model calls made by this process; removed when it exits. */
const modelWorkDirs = new Set<string>();
process.once('exit', () => {
  for (const d of modelWorkDirs) fs.rmSync(d, { recursive: true, force: true });
});

function run(cmd: string, args: string[], input: string | null, timeoutMs: number, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // Synaptome's own model calls must not be routed by Synaptome's own prompt hook (a project with the bridge would
    // otherwise record gaps and decisions for the forge's and agents' internal prompts). The hook exits on this flag.
    // On Windows `claude` is a .cmd file, which Node starts only through cmd.exe. The arguments are built here (quoted
    // by the caller; model and program validated, T-06), so they are passed as one command line rather than an array
    // with `shell: true`, which Node deprecates (DEP0190).
    const env = { ...process.env, SYNAPTOME_INTERNAL_CALL: '1' };
    const child = process.platform === 'win32' ? spawn([cmd, ...args].join(' '), { cwd, shell: true, windowsHide: true, env }) : spawn(cmd, args, { cwd, windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Uses the user's existing Claude Code login (no credentials are read or stored by Synaptome).
 * The prompt is passed on stdin. `exec` is injectable for tests.
 */
export function claudeCliProvider(opts: { model?: string; exec?: typeof run; bin?: string } = {}): ModelProvider {
  const exec = opts.exec ?? run;
  const bin = opts.bin ?? 'claude';
  // On Windows the command runs through cmd.exe, so nothing from settings may carry shell syntax (T-06).
  if (opts.model && !/^[\w.:@/-]{1,100}$/.test(opts.model)) throw new Error(`Model name "${opts.model}" has characters a model name never needs; refused`);
  if (!/^[\w.:\\/ ~()+-]{1,260}$/.test(bin)) throw new Error(`Program path "${bin}" has shell characters; refused`);
  // Everything that is not a plain flag goes through a file: argument quoting through cmd.exe is not
  // reliable for JSON or multi-line text. The folder is made on the first model call (building the provider list
  // must not leave anything behind; found by the clean-room check) and removed when the process exits.
  let work: string | null = null;
  const workDir = () => {
    if (!work) {
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-model-'));
      fs.writeFileSync(path.join(work, 'no-mcp.json'), '{"mcpServers":{}}');
      modelWorkDirs.add(work);
    }
    return work;
  };
  const q = (s: string) => (s === '' ? '""' : /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const baseArgs = () => ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', q(path.join(workDir(), 'no-mcp.json')), ...(opts.model ? ['--model', opts.model] : [])];
  let n = 0;
  const parse = (stdout: string) => {
    try {
      const o = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '');
      return { text: String(o.result ?? ''), isError: !!o.is_error, raw: o };
    } catch {
      return { text: stdout, isError: true, raw: null };
    }
  };
  let cached: { available: boolean; authenticated: boolean; detail: string } | null = null;
  return {
    id: 'claude-code-headless',
    title: 'Claude Code (headless)',
    async availability() {
      if (cached) return cached;
      const r = await exec(bin, baseArgs(), 'Reply with exactly: OK', 60000);
      if (r.code === -1 || /not recognized|not found|ENOENT/i.test(r.stderr)) return (cached = { available: false, authenticated: false, detail: 'claude CLI not found on PATH' });
      const p = parse(r.stdout);
      if (p.isError) return (cached = { available: true, authenticated: !/authenticat|oauth|login|api key/i.test(p.text), detail: p.text.slice(0, 200) || r.stderr.slice(0, 200) || `exit ${r.code}` });
      return (cached = { available: true, authenticated: true, detail: 'headless run succeeded' });
    },
    async complete(req) {
      const started = Date.now();
      // Quoted like every other argument: a tool scope such as "Bash(node --test:*)" contains spaces and would
      // otherwise be split by the shell into separate (and partly option-like) arguments.
      // Text only by default: no built-in tools, in an empty working folder. A call that needs tools (an agent) says so
      // with --tools or --allowedTools and its own working directory. Without this, a prompt such as "write a CI step"
      // made the model start working on files in whatever folder Synaptome happened to run in.
      const extra = req.extraArgs ?? [];
      const wantsTools = extra.some((a) => a === '--tools' || a === '--allowedTools' || a === '--allowed-tools');
      const base = baseArgs();
      const args = [...base, ...(wantsTools ? [] : ['--tools', '']), ...extra].map((a, i) => (i < base.length ? a : q(a)));
      if (req.system) {
        const f = path.join(workDir(), `system-${++n}.md`);
        fs.writeFileSync(f, req.system);
        args.push('--append-system-prompt-file', q(f));
      }
      const r = await exec(bin, args, req.prompt, req.timeoutMs ?? 180000, req.cwd ?? (wantsTools ? undefined : workDir()));
      const p = parse(r.stdout);
      if (r.timedOut) return { ok: false, text: '', error: 'timed out', ms: Date.now() - started };
      if (p.isError) return { ok: false, text: '', error: p.text.slice(0, 300) || r.stderr.slice(0, 300), raw: p.raw, ms: Date.now() - started };
      const u = p.raw?.usage;
      const usage = u ? { inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0) } : undefined;
      return { ok: true, text: p.text, raw: p.raw, ms: Date.now() - started, usage };
    },
  };
}

export * from './sets';
