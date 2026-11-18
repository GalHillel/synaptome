/**
 * Real-session host benchmark (plan NG, M0 and M2). Runs real `claude -p` sessions in disposable projects and records
 * what actually happened, from Claude Code's own stream: which tools were called, whether a skill was loaded (the
 * `Skill` tool) or a Synaptome capability fetched (`mcp__synaptome__get_capability`), cost, time, and the result of an
 * objective check command run afterwards in the project. Never trusts the model's own claim of success.
 *
 * It spends real model budget, so it is a DRY RUN unless `--run` is given together with both caps. The dry run prints
 * the exact plan (sessions, model, per-session and total caps) to put to the owner for approval.
 *
 *   npx tsx scripts/host-bench.ts --tasks tests/host/tasks/baseline.json [--arms control,bridge] [--repeat 1]
 *        [--profile clean|realistic] [--model <id>] [--only id1,id2]
 *        [--run --max-usd-per-session 0.5 --max-usd-total 10] [--out .tmp/host-bench]
 *
 * Profiles: clean = `--setting-sources project,local` (user-level settings, hooks and plugins do not load; user-level
 * skills in ~/.claude/skills still do, which is reported as a limitation of this isolation); realistic = the user's
 * settings as they are, read only. Projects and the Synaptome home are disposable copies; nothing personal is written.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const val = (f: string, d?: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const has = (f: string) => argv.includes(f);

interface Task { id: string; prompt: string; needs: string[]; check?: string; files?: Record<string, string> }
interface Session {
  task: string; arm: string; rep: number; ok: boolean; error?: string; costUsd: number | null; ms: number;
  tools: string[]; skillsLoaded: string[]; synaptomeFetched: string[]; hookContext: boolean; offered: string[];
  check: { command: string; exit: number | null } | null; resultText: string;
}

const tasks: Task[] = JSON.parse(fs.readFileSync(path.resolve(val('--tasks', 'tests/host/tasks/baseline.json')!), 'utf8')).filter((t: Task) => !val('--only') || val('--only')!.split(',').includes(t.id));
const arms = val('--arms', 'control,bridge')!.split(',');
const repeat = Number(val('--repeat', '1'));
const profile = val('--profile', 'clean')!;
const model = val('--model');
const perSession = Number(val('--max-usd-per-session', 'NaN'));
const total = Number(val('--max-usd-total', 'NaN'));
const out = path.resolve(val('--out', path.join(ROOT, '.tmp', 'host-bench', new Date().toISOString().replace(/[:.]/g, '-')))!);
const sessions = tasks.length * arms.length * repeat;

const plan = { tasks: tasks.length, arms, repeat, sessions, profile, model: model ?? '(Claude Code default)', maxUsdPerSession: perSession, maxUsdTotal: total, ceiling: Number.isFinite(perSession) ? Math.min(sessions * perSession, total) : null };
process.stdout.write(`host benchmark plan\n${JSON.stringify(plan, null, 2)}\n`);
if (!has('--run')) {
  process.stdout.write('\nDRY RUN: nothing was started. Add --run with --max-usd-per-session and --max-usd-total once the owner has approved this scope.\n');
  process.exit(0);
}
if (!Number.isFinite(perSession) || !Number.isFinite(total) || perSession <= 0 || total <= 0) throw new Error('--run needs --max-usd-per-session and --max-usd-total');

// A disposable Synaptome home: a consistent copy of the development registry (online backup; the source is only read).
const dist = path.join(ROOT, 'dist', 'synaptome.mjs');
if (arms.includes('bridge') && !fs.existsSync(dist)) throw new Error('build first (npm run build): the bridge must use the built package');
fs.mkdirSync(out, { recursive: true });
const home = path.join(out, 'home');
fs.mkdirSync(home, { recursive: true });
const srcDb = new DatabaseSync(path.join(ROOT, '.synaptome-dev', 'synaptome.db'), { readOnly: true });
await backup(srcDb, path.join(home, 'synaptome.db'));
srcDb.close();
fs.cpSync(path.join(ROOT, '.synaptome-dev', 'store'), path.join(home, 'store'), { recursive: true });

const syn = (args: string[]) => spawnSync(process.execPath, [dist, '--home', home, ...args], { encoding: 'utf8', env: { ...process.env, SYNAPTOME_LAUNCHER: dist } });

function claude(project: string, prompt: string): Promise<{ lines: any[]; ms: number; code: number | null }> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--max-budget-usd', String(perSession), '--setting-sources', profile === 'clean' ? 'project,local' : 'user,project,local', ...(model ? ['--model', model] : [])];
  if (args.some((a) => /[\s"&|<>^%]/.test(a))) throw new Error('unsafe argument');
  const t0 = Date.now();
  return new Promise((resolve) => {
    // The prompt goes through stdin, so no user text is ever part of a shell command line.
    const child = process.platform === 'win32' ? spawn(['claude', ...args].join(' '), { cwd: project, shell: true }) : spawn('claude', args, { cwd: project });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stdin.end(prompt);
    child.on('close', (code) => resolve({ lines: buf.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }), ms: Date.now() - t0, code }));
  });
}

const results: Session[] = [];
let spent = 0;
for (const task of tasks) for (const arm of arms) for (let rep = 1; rep <= repeat; rep++) {
  if (spent >= total) break;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `synaptome-hb-${task.id}-`));
  for (const [f, c] of Object.entries(task.files ?? {})) fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true }), fs.writeFileSync(path.join(project, f), c);
  if (arm === 'bridge') {
    const b = syn(['bridge', 'init', project]);
    if (b.status !== 0) throw new Error(`bridge init failed: ${b.stderr}`);
  }
  const before = Number(JSON.parse(syn(['--json', 'decisions']).stdout || '[]')[0]?.id ?? 0);
  const r = await claude(project, task.prompt);
  const tools: string[] = [];
  const skills: string[] = [];
  const fetched: string[] = [];
  let hookContext = false;
  for (const l of r.lines) {
    for (const b of l.type === 'assistant' ? l.message?.content ?? [] : []) if (b.type === 'tool_use') {
      tools.push(b.name);
      if (b.name === 'Skill') skills.push(String(b.input?.skill ?? b.input?.command ?? ''));
      if (b.name === 'mcp__synaptome__get_capability') fetched.push(String(b.input?.capability_id ?? b.input?.id ?? ''));
    }
    if (l.type === 'system' && /hook/.test(String(l.subtype)) && /UserPromptSubmit/.test(JSON.stringify(l)) && /additionalContext/.test(JSON.stringify(l))) hookContext = true;
  }
  const result = r.lines.find((l) => l.type === 'result') ?? {};
  const decisions = JSON.parse(syn(['--json', 'decisions']).stdout || '[]').filter((d: any) => d.id > before);
  const offered = decisions.flatMap((d: any) => (d.selected ?? []).map((s: any) => s.capabilityId ?? s.capability_id));
  let check: Session['check'] = null;
  if (task.check) {
    const c = spawnSync(task.check, { cwd: project, shell: true, encoding: 'utf8', timeout: 300_000 });
    check = { command: task.check, exit: c.status };
  }
  const cost = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
  spent += cost ?? perSession;
  results.push({ task: task.id, arm, rep, ok: r.code === 0 && !result.is_error, error: result.is_error ? String(result.result ?? result.subtype) : undefined, costUsd: cost, ms: r.ms, tools, skillsLoaded: skills, synaptomeFetched: fetched, hookContext, offered, check, resultText: String(result.result ?? '').slice(0, 400) });
  fs.writeFileSync(path.join(out, 'sessions.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`${task.id} ${arm} #${rep}: tools=${tools.length} skills=[${skills}] fetched=[${fetched}] offered=[${offered}] check=${check?.exit ?? '-'} $${cost ?? '?'}\n`);
  fs.rmSync(project, { recursive: true, force: true });
}

// Summary per arm. "Loaded" counts only what Claude Code's own stream shows; nothing is inferred from the model's text.
const summary = arms.map((arm) => {
  const s = results.filter((x) => x.arm === arm);
  const relevant = s.filter((x) => (tasks.find((t) => t.id === x.task)?.needs.length ?? 0) > 0);
  const checked = s.filter((x) => x.check);
  return { arm, sessions: s.length, anySkillLoaded: s.filter((x) => x.skillsLoaded.length).length, synaptomeFetched: s.filter((x) => x.synaptomeFetched.length).length, relevantSessions: relevant.length, relevantLoaded: relevant.filter((x) => x.skillsLoaded.length || x.synaptomeFetched.length).length, checksPassed: checked.filter((x) => x.check!.exit === 0).length, checks: checked.length, costUsd: Number(s.reduce((n, x) => n + (x.costUsd ?? 0), 0).toFixed(4)), medianMs: s.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(s.length / 2)] ?? null };
});
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ plan, spent, summary }, null, 2));
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\nresults: ${out}\n`);
