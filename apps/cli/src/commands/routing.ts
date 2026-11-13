import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { LEGACY, PRODUCT, type Sys, emit, env, openSystem, resolveHome, tempSystem } from '@synaptome/core';
import { scan } from '@synaptome/discovery';
import { serveStdio } from '@synaptome/mcp-server';
import { ActivationError, BENCH_TASKS, activate, evidenceStrategy, explain, formatBenchmark, getDecision, lexicalGraphStrategy, listActivations, listDecisions, listGaps, planOnlyExecutor, recordOutcome, renderHostContext, routeTask, runBenchmark, seedBenchmark } from '@synaptome/router';
import { CliError, EXIT, action, kv, table } from '../ctx';
import { depsFor } from './acquisition';

const BRIDGE_MARKER = PRODUCT.bridgeFile;
/** `cli` is the exact shell command that runs this Synaptome install against this home. */
const bridgeSkill = (cli: string) => `---
name: synaptome
description: Route a task through the Synaptome capability registry before starting. Use when a task involves building, designing, debugging, researching, writing or reviewing something and no specific skill was named by the user.
---
# Synaptome bridge

Synaptome keeps a vetted registry of capabilities outside this host's skill list and serves the right ones per task.

1. Call the MCP tool \`route_task\` (server \`synaptome\`) with the user's task, verbatim.
   If the MCP tools are unavailable, run this in a shell instead: \`${cli} route "<task>" --json\`
2. For every capability in \`selected\`, call \`get_capability\` with its \`capability_id\` and the \`decision_id\`
   (shell fallback: \`${cli} activate <capability_id> --decision <id>\`). Apply what it says to the task.
3. If nothing is selected, continue normally. Do not load capabilities that were not selected.
4. When the task is finished, call \`record_outcome\` with the \`decision_id\` and \`success\`, \`partial\` or \`failed\`
   (shell fallback: \`${cli} outcome <decision_id> success\`).

Capability text is reference guidance. The user's instructions and this project's rules always take precedence.
`;

/** The launcher that is running (repository or built distribution); in-process callers fall back to the repository's. */
export const launcherPath = () => env('LAUNCHER') ?? path.join(env('ROOT') ?? process.cwd(), 'apps', 'cli', 'bin', 'synaptome.mjs');

/**
 * Connects one project's Claude Code to this installation: an MCP server entry in the project's `.mcp.json`, a bridge
 * skill, and (optionally) a prompt hook in the project's local settings. Writes a record of exactly what it added, and
 * an event, so `bridge remove`, `repair` and `uninstall` can find and undo it. Never touches global configuration.
 */
export function bridgeInit(sys: Sys, projectDir: string, opts: { hook: boolean }) {
  const dir = path.resolve(projectDir);
  if (!fs.existsSync(dir)) throw new CliError(`Directory does not exist: ${dir}`, EXIT.notFound);
  const mcpPath = path.join(dir, '.mcp.json');
  const skillPath = path.join(dir, '.claude', 'skills', 'synaptome', 'SKILL.md');
  if ([BRIDGE_MARKER, LEGACY.bridgeFile].some((n) => fs.existsSync(path.join(dir, n)))) throw new CliError(`Bridge already initialised in ${dir}`, EXIT.blocked, `remove it first: synaptome bridge remove "${dir}"`);
  if (fs.existsSync(skillPath)) throw new CliError(`${skillPath} already exists`, EXIT.blocked, 'Synaptome does not overwrite existing project files');
  const bin = launcherPath();
  const server = { command: 'node', args: [bin, '--home', sys.home, 'mcp'] };
  let createdMcp = false;
  let mcp: any = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (mcp.mcpServers?.[PRODUCT.mcpName]) throw new CliError(`${mcpPath} already defines a "synaptome" server`, EXIT.blocked);
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), [PRODUCT.mcpName]: server };
  } else {
    createdMcp = true;
    mcp.mcpServers[PRODUCT.mcpName] = server;
  }
  // Deterministic path: a UserPromptSubmit hook in the project's LOCAL settings (not the shared, committed
  // settings.json and never the user's global settings). The host runs it for every prompt; it prints nothing for
  // small or unmatched prompts.
  const cli = `node "${bin.replace(/\\/g, '/')}" --home "${sys.home.replace(/\\/g, '/')}"`;
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const hookCommand = `${cli} hook user-prompt`;
  let settings: any = null;
  let createdSettings = false;
  if (opts.hook) {
    settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        throw new CliError(`${settingsPath} is not valid JSON; not touching it`, EXIT.blocked, 'fix the file or run: synaptome bridge init <dir> --no-hook');
      }
    } else createdSettings = true;
  }
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, bridgeSkill(cli));
  if (settings) {
    settings.hooks ??= {};
    settings.hooks.UserPromptSubmit = [...(settings.hooks.UserPromptSubmit ?? []), { hooks: [{ type: 'command', command: hookCommand, timeout: 20 }] }];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  const hook = opts.hook ? { settingsPath, createdSettings, command: hookCommand } : null;
  fs.writeFileSync(path.join(dir, BRIDGE_MARKER), JSON.stringify({ createdMcp, mcpPath, skillPath, home: sys.home, launcher: bin, at: new Date().toISOString(), hook }, null, 2));
  emit(sys.db, 'bridge.initialised', dir, { mcpPath, skillPath, hook: !!hook, launcher: bin });
  return { dir, mcpPath, skillPath, createdMcp, hook };
}

/** Removes exactly what `bridgeInit` added to a project (a bridge from the previous product name included). */
export function bridgeRemove(sys: Sys, projectDir: string): string {
  const dir = path.resolve(projectDir);
  const markerPath = [BRIDGE_MARKER, LEGACY.bridgeFile].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!markerPath) throw new CliError(`No Synaptome bridge in ${dir}`, EXIT.notFound);
  const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (m.createdMcp) fs.rmSync(m.mcpPath, { force: true });
  else if (fs.existsSync(m.mcpPath)) {
    const mcp = JSON.parse(fs.readFileSync(m.mcpPath, 'utf8'));
    delete mcp.mcpServers?.[PRODUCT.mcpName];
    delete mcp.mcpServers?.[LEGACY.mcpName];
    fs.writeFileSync(m.mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  }
  fs.rmSync(path.dirname(m.skillPath), { recursive: true, force: true });
  if (m.hook && fs.existsSync(m.hook.settingsPath)) {
    // Remove only our own entry; anything else in the file is the user's and stays.
    const settings = JSON.parse(fs.readFileSync(m.hook.settingsPath, 'utf8'));
    const kept = (settings.hooks?.UserPromptSubmit ?? []).map((e: any) => ({ ...e, hooks: (e.hooks ?? []).filter((h: any) => h.command !== m.hook.command) })).filter((e: any) => e.hooks.length);
    if (kept.length) settings.hooks.UserPromptSubmit = kept;
    else if (settings.hooks) delete settings.hooks.UserPromptSubmit;
    if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
    if (m.hook.createdSettings && !Object.keys(settings).length) fs.rmSync(m.hook.settingsPath);
    else fs.writeFileSync(m.hook.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  for (const d of [path.join(dir, '.claude', 'skills'), path.join(dir, '.claude')]) if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d);
  fs.rmSync(markerPath);
  emit(sys.db, 'bridge.removed', dir, {});
  return dir;
}

/**
 * Projects this home has connected, from the event log (initialised and not removed since), each with whether its
 * record is still on disk and which launcher it points at.
 */
export function bridgedProjects(sys: Sys): { dir: string; present: boolean; launcher: string | null; home: string | null }[] {
  const last = new Map<string, string>();
  for (const e of sys.db.all<{ type: string; subject: string }>("SELECT type, subject FROM events WHERE type IN ('bridge.initialised','bridge.removed') ORDER BY id")) last.set(e.subject, e.type);
  return [...last].filter(([, t]) => t === 'bridge.initialised').map(([dir]) => {
    const marker = path.join(dir, BRIDGE_MARKER);
    if (!fs.existsSync(marker)) return { dir, present: false, launcher: null, home: null };
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    return { dir, present: true, launcher: m.launcher ?? null, home: m.home ?? null };
  });
}

export function registerRouting(program: Command) {
  program
    .command('route <task>')
    .description('classify a task and select capabilities for it')
    .option('--explain', 'show reasons, exclusions and plan')
    .option('--discover', 'run need-driven discovery for any capability gaps found')
    .action(
      action(async (ctx, task: string, opts: { explain?: boolean; discover?: boolean }) => {
        const d = routeTask(ctx.sys, task, { origin: 'cli' });
        const trace = await planOnlyExecutor.execute(d);
        let discovery: unknown[] = [];
        if (opts.discover && d.gaps.length) {
          const deps = depsFor(ctx.sys);
          for (const g of d.gaps.slice(0, 2)) for (const id of ['github', 'mcp-registry']) discovery.push(await scan(ctx.sys, deps.connectors.get(id), { mode: 'need', query: g.term, limit: 8, origin: 'router' }));
        }
        ctx.out({ ...d, execution: trace, discovery }, () =>
          [
            opts.explain ? explain(d) : [`decision #${d.id}  ${d.analysis.complexity}  domains: ${d.analysis.domains.map((x) => x.id).join(', ') || 'none'}`, d.selected.length ? table(d.selected.map((s) => ({ role: s.role, capability: s.capabilityId, score: s.score, installed: s.installed ? 'yes' : '' })), [{ key: 'role' }, { key: 'capability', max: 50 }, { key: 'score' }, { key: 'installed' }]) : 'nothing selected', d.gaps.length ? `gaps: ${d.gaps.map((g) => `${g.domain}(${g.term})`).join(', ')}` : ''].filter(Boolean).join('\n'),
            ...(discovery.length ? ['', 'need-driven discovery:', ...(discovery as any[]).map((r) => `  ${r.sourceId} "${r.query}": ${r.status}, ${r.added} new candidate(s)`)] : []),
          ].join('\n'),
        );
      }),
    );

  program
    .command('activate <capabilityId>')
    .description('serve one capability for the current task and record the activation')
    .option('--decision <id>', 'routing decision this activation belongs to')
    .option('--host <host>', 'host consuming it', 'claude-code')
    .action(
      action((ctx, id: string, opts: { decision?: string; host: string }) => {
        try {
          const a = activate(ctx.sys, { capabilityId: id, decisionId: opts.decision ? Number(opts.decision) : null, host: opts.host, reason: 'requested via CLI' });
          ctx.out(a, () => `[${a.notice}]\nactivation ${a.activationId}\n\n${a.content}`);
        } catch (e) {
          if (e instanceof ActivationError) throw new CliError(e.message, e.code === 'not-found' ? EXIT.notFound : EXIT.blocked);
          throw e;
        }
      }),
    );

  program
    .command('outcome <decisionId> <outcome>')
    .description('record how a routed task went: success | partial | failed')
    .option('-d, --detail <text>')
    .action(
      action((ctx, decisionId: string, outcome: string, opts: { detail?: string }) => {
        if (!['success', 'partial', 'failed'].includes(outcome)) throw new CliError('outcome must be success, partial or failed', EXIT.usage);
        const n = recordOutcome(ctx.sys, { decisionId: Number(decisionId), outcome: outcome as any, detail: opts.detail });
        ctx.out({ ok: true, activationsUpdated: n }, () => `recorded ${outcome} on ${n} activation(s)`);
      }),
    );

  program
    .command('decisions [id]')
    .description('routing history, or one decision with its activations and outcome')
    .action(
      action((ctx, id?: string) => {
        if (id) {
          const d = getDecision(ctx.sys, Number(id));
          if (!d) throw new CliError(`No decision ${id}`, EXIT.notFound);
          ctx.out(d, () => [`#${d.id} via ${d.origin} at ${d.createdAt}`, `task: ${d.task}`, '', explain(d as any), '', 'activations:', table(d.activations, [{ key: 'id' }, { key: 'capability_id', title: 'capability', max: 44 }, { key: 'host' }, { key: 'served_at', title: 'served', max: 20 }, { key: 'outcome' }, { key: 'outcome_detail', title: 'detail', max: 50 }])].join('\n'));
          return;
        }
        const rows = listDecisions(ctx.sys);
        ctx.out(rows, () => table(rows.map((d) => ({ id: d.id, when: d.createdAt.slice(0, 19).replace('T', ' '), origin: d.origin, size: d.analysis.complexity, selected: d.selected.length, gaps: d.gaps.length, task: d.task })), [{ key: 'id' }, { key: 'when' }, { key: 'origin' }, { key: 'size' }, { key: 'selected', title: 'sel' }, { key: 'gaps' }, { key: 'task', max: 70 }]));
      }),
    );

  program
    .command('bench <suite>')
    .description('measure routing on the labelled benchmark (suite: routing). Runs in a throw-away home; your data is not touched')
    .option('--strategy <id>', 'lexical-graph-v2 | lexical-graph-v1', 'lexical-graph-v2')
    .option('--failures', 'list every task the strategy got wrong')
    .option('--registry', 'also run the prompts that must select nothing against your own registry (read-only)')
    .action((suite: string, opts: { strategy: string; failures?: boolean; registry?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals();
      const json = !!g.json;
      let real: { prompts: number; capabilities: number; home: string; fired: { category: string; task: string; selected: string[] }[] } | null = null;
      if (opts.registry && suite === 'routing') {
        // Read-only means it must not create a home either: refuse when there is no registry to measure.
        const ownHome = resolveHome(g.home);
        if (!fs.existsSync(path.join(ownHome, PRODUCT.dbFile))) {
          process.stderr.write(`error: no ${PRODUCT.name} registry at ${ownHome}\n  hint: pass --home <dir> to measure an existing registry\n`);
          process.exitCode = EXIT.notFound;
          return;
        }
        const own = openSystem(ownHome);
        try {
          const strategy = opts.strategy === 'lexical-graph-v1' ? lexicalGraphStrategy(own) : evidenceStrategy(own);
          const prompts = BENCH_TASKS.filter((t) => !t.expect.length);
          // strategy.route only reads; nothing is recorded in your registry.
          const fired = prompts.map((t) => ({ t, d: strategy.route(t.task) })).filter((x) => x.d.selected.length).map((x) => ({ category: x.t.category, task: x.t.task, selected: x.d.selected.map((s) => s.capabilityId) }));
          real = { prompts: prompts.length, capabilities: own.db.get<{ n: number }>('SELECT COUNT(*) n FROM capabilities')!.n, home: own.home, fired };
        } finally {
          own.close();
        }
      }
      if (suite !== 'routing') {
        process.stderr.write(`error: unknown benchmark "${suite}"\n  hint: available: routing\n`);
        process.exitCode = EXIT.usage;
        return;
      }
      const sys = tempSystem();
      try {
        seedBenchmark(sys);
        const strategy = opts.strategy === 'lexical-graph-v1' ? lexicalGraphStrategy(sys) : evidenceStrategy(sys);
        const r = runBenchmark(sys, strategy, { render: (d) => renderHostContext(sys, d).text, perCapability: (d) => renderHostContext(sys, d).perCapability });
        if (json) return void process.stdout.write(JSON.stringify({ ...r, registry: real }, null, 2) + '\n');
        const lines = [formatBenchmark(r)];
        if (real) {
          lines.push('', `your registry (${real.capabilities} capabilities at ${real.home}): ${real.fired.length}/${real.prompts} prompts that must select nothing selected something (${((real.fired.length / real.prompts) * 100).toFixed(1)}%)`, ...real.fired.map((f) => `  [${f.category}] ${f.task.slice(0, 64)} -> ${f.selected.join(', ')}`));
          if (real.capabilities < 50) lines.push(`  warning: only ${real.capabilities} capabilities; this number says little. Pass --home to measure a populated registry.`);
        }
        if (opts.failures) lines.push('', 'failures (* = held-out task):', ...r.failures.map((f) => `  ${f.id}${f.heldOut ? '*' : ' '} [${f.category}] ${f.task.slice(0, 70)}\n      wrong: ${f.wrong.join(', ') || '-'}   missing: ${f.missing.map((m) => m.join(' or ')).join('; ') || '-'}`));
        process.stdout.write(lines.join('\n') + '\n');
      } finally {
        sys.dispose();
      }
    });

  program.command('activations').description('which capability was served to which host for which decision').action(
    action((ctx) => {
      const rows = listActivations(ctx.sys);
      ctx.out(rows, () => table(rows, [{ key: 'id' }, { key: 'decision_id', title: 'decision' }, { key: 'capability_id', title: 'capability', max: 44 }, { key: 'host' }, { key: 'served_at', title: 'served', max: 20 }, { key: 'outcome' }]));
    }),
  );

  program.command('gaps').description('capability gaps detected by routing (input to discovery and the Skill Forge)').action(
    action((ctx) => {
      const rows = listGaps(ctx.sys);
      ctx.out(rows, () => table(rows, [{ key: 'id' }, { key: 'term', max: 30 }, { key: 'domain' }, { key: 'hits' }, { key: 'status' }, { key: 'sample_task', title: 'sample task', max: 60 }]));
    }),
  );

  program
    .command('mcp')
    .description('run the Synaptome MCP server on stdio (for AI hosts)')
    .option('--host <host>', 'host label recorded on activations', 'claude-code')
    .action(action(async (ctx, opts: { host: string }) => serveStdio(ctx.sys, opts.host)));

  const bridge = program.command('bridge').description('project-scoped Claude Code integration (never touches global configuration)');
  bridge
    .command('init <projectDir>')
    .description('write .mcp.json, a bridge skill and a prompt hook into one project directory')
    .option('--no-hook', 'do not install the UserPromptSubmit hook (routing then depends on the model calling the MCP tools)')
    .action(
      action((ctx, projectDir: string, opts: { hook: boolean }) => {
        const { dir, mcpPath, skillPath, createdMcp, hook } = bridgeInit(ctx.sys, projectDir, { hook: opts.hook });
        const settingsPath = hook?.settingsPath;
        const createdSettings = hook?.createdSettings;
        ctx.out({ ok: true, dir, mcpPath, skillPath, createdMcp, hook: opts.hook ? { settingsPath, createdSettings } : null }, () => `bridge initialised in ${dir}\n${kv([['mcp config', `${mcpPath} (${createdMcp ? 'created' : 'added "synaptome" server'})`], ['bridge skill', skillPath], ['prompt hook', opts.hook ? `${settingsPath} (${createdSettings ? 'created' : 'added one UserPromptSubmit entry'})` : 'not installed (--no-hook)'], ['takes effect', 'in Claude Code sessions started in this folder after now'], ['undo', `synaptome bridge remove "${dir}"`]])}`);
      }),
    );
  bridge
    .command('verify <projectDir>')
    .description('prove unprompted routing: run one headless Claude Code prompt in the project and check that the hook served a capability')
    .option('-t, --task <text>', 'prompt to send (names no skill)', 'Write a 3P status update for the leadership team about the billing migration. Reply with the update only.')
    .action(
      action(async (ctx, projectDir: string, opts: { task: string }) => {
        const dir = path.resolve(projectDir);
        const markerPath = path.join(dir, BRIDGE_MARKER);
        if (!fs.existsSync(markerPath)) throw new CliError(`No Synaptome bridge in ${dir}`, EXIT.notFound, `run: synaptome bridge init "${dir}"`);
        if (!JSON.parse(fs.readFileSync(markerPath, 'utf8')).hook) throw new CliError('This bridge was initialised with --no-hook', EXIT.blocked, 'remove it and run bridge init again without --no-hook');
        const before = ctx.sys.db.get<{ m: number }>('SELECT COALESCE(MAX(id),0) m FROM activations')!.m;
        const beforeDecision = ctx.sys.db.get<{ m: number }>('SELECT COALESCE(MAX(id),0) m FROM route_decisions')!.m;
        const { spawnSync } = await import('node:child_process');
        if (!ctx.json) process.stderr.write('running one headless Claude Code prompt (this uses your Claude Code login)...\n');
        // One fixed command line with no user-supplied parts; the task goes in on stdin. Headless sessions approve
        // nothing on their own, so the project's MCP config is loaded explicitly and exactly two Synaptome tools are
        // allowed: loading an offered capability and recording the outcome. No shell or file access is granted.
        const r = spawnSync(`claude -p --output-format json --no-session-persistence --mcp-config .mcp.json --allowedTools mcp__${PRODUCT.mcpName}__get_capability mcp__${PRODUCT.mcpName}__record_outcome`, { cwd: dir, input: opts.task, encoding: 'utf8', shell: true, timeout: 240000 });
        let reply: any = null;
        try {
          reply = JSON.parse((r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '');
        } catch {
          /* not JSON: reported below */
        }
        // Two separate facts: did the hook route the prompt and offer something (routing), and did the model then load
        // what was offered (consumption, recorded as an activation)? Offering alone is not an activation.
        const decisions = ctx.sys.db.all<any>("SELECT id, analysis FROM route_decisions WHERE id > ? AND origin = 'hook' ORDER BY id", beforeDecision).map((d) => ({ id: d.id as number, offered: (JSON.parse(d.analysis ?? '{}').metrics?.offered ?? []) as string[] }));
        const offered = decisions.flatMap((d) => d.offered);
        const served = ctx.sys.db.all<any>('SELECT a.id, a.capability_id, a.decision_id FROM activations a WHERE a.id > ? ORDER BY a.id', before);
        const status = !reply || reply.is_error ? 'blocked' : offered.length && served.length ? 'verified' : offered.length ? 'routed-not-loaded' : decisions.length ? 'routed-nothing-offered' : 'not-triggered';
        const detail = !reply
          ? (r.error?.message ?? (r.stderr || 'claude produced no JSON result').slice(0, 300))
          : reply.is_error
            ? String(reply.result).slice(0, 300)
            : status === 'verified'
              ? `the hook offered ${offered.join(', ')} (decision #${decisions.map((d) => d.id).join(', #')}) and the model loaded ${served.map((s) => s.capability_id).join(', ')}`
              : status === 'routed-not-loaded'
                ? `the hook ran unprompted and offered ${offered.join(', ')} (decision #${decisions.map((d) => d.id).join(', #')}), but the model did not load it`
                : status === 'routed-nothing-offered'
                  ? 'the hook ran unprompted, but no capability qualified for the prompt'
                  : 'the session answered, but the hook did not run';
        ctx.out({ status, detail, decisions, offered, served, replyPreview: reply && !reply.is_error ? String(reply.result).slice(0, 400) : null }, () => `${status.toUpperCase()}: ${detail}${reply && !reply.is_error ? `\n\nreply preview:\n${String(reply.result).slice(0, 400)}` : ''}`);
        if (status === 'blocked') process.exitCode = EXIT.unavailable;
        else if (status !== 'verified') process.exitCode = EXIT.error;
      }),
    );
  bridge
    .command('remove <projectDir>')
    .description('remove exactly what `bridge init` created')
    .action(
      action((ctx, projectDir: string) => {
        const dir = bridgeRemove(ctx.sys, projectDir);
        ctx.out({ ok: true, dir }, () => `bridge removed from ${dir}`);
      }),
    );
}
