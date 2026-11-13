import path from 'node:path';
import type { Command } from 'commander';
import { SPECIALISTS, trace } from '@synaptome/agents';
import { findWorkflow, startRun } from '@synaptome/workflow';
import { CliError, EXIT, action, kv, table } from '../ctx';
import { execute, renderRun } from './workflow';

export function registerAgents(program: Command) {
  const agents = program.command('agents').description('the specialist agents a team is made of');
  agents.command('list', { isDefault: true }).description('every specialist and what it may touch').action(
    action((ctx) => ctx.out(SPECIALISTS, () => table(SPECIALISTS.map((a) => ({ id: a.id, title: a.title, workspace: a.workspace, role: a.role })), [{ key: 'id' }, { key: 'title' }, { key: 'workspace' }, { key: 'role', max: 70 }]))),
  );
  agents.command('show <agentId>').description('one specialist, with its full instructions').action(
    action((ctx, id: string) => {
      const a = SPECIALISTS.find((x) => x.id === id);
      if (!a) throw new CliError(`No agent "${id}"`, EXIT.notFound, 'list them with: synaptome agents');
      ctx.out(a, () => [kv([['agent', `${a.id} — ${a.title}`], ['role', a.role], ['workspace', a.workspace], ['capabilities', a.capabilities.join(', ')]]), '', a.instructions].join('\n'));
    }),
  );

  program
    .command('team')
    .description('specialist teams')
    .command('run <task>')
    .description('research → architecture → implementation → review and tests → one repair round if needed, in a git repository')
    .requiredOption('--workdir <dir>', 'a git repository to work in (every change stays reviewable with git diff)')
    .option('--provider <id>', 'model provider (default: the preferred available one)')
    .action(
      action(async (ctx, task: string, opts: { workdir: string; provider?: string }) => {
        const w = findWorkflow(ctx.sys, 'team.build')!;
        const runId = startRun(ctx.sys, w.def, { task, workdir: path.resolve(opts.workdir), provider: opts.provider ?? '' }, { by: 'cli' });
        if (!ctx.json) process.stderr.write(`team run ${runId} started in ${path.resolve(opts.workdir)}\n`);
        const v = await execute(ctx, runId);
        ctx.out(v, () => renderRun(v));
      }),
    );

  program
    .command('trace <runId>')
    .description('every model call of a run: agent, provider, tokens, cost, time, plus totals, budget and team notes')
    .action(
      action((ctx, id: string) => {
        const t = trace(ctx.sys, id);
        if (!t) throw new CliError(`No workflow run "${id}"`, EXIT.notFound);
        ctx.out(t, () =>
          [
            kv([['run', `${t.run.id} — ${t.run.title} (${t.run.status})`], ['calls', String(t.totals.calls)], ['tokens', `${t.totals.tokens}${t.budget?.tokens ? ` of ${t.budget.tokens}` : ''}`], ['cost', t.totals.usd === null ? 'unknown (no price configured)' : `$${t.totals.usd.toFixed(4)}`], ['elapsed', `${Math.round(t.totals.ms / 1000)} s${t.budget?.ms ? ` of ${Math.round(t.budget.ms / 1000)} s` : ''}`]]),
            '',
            table(t.calls.map((c) => ({ step: c.step, agent: c.agent, provider: c.provider, ok: c.ok ? 'ok' : `failed: ${c.error}`, tokens: (c.inputTokens ?? 0) + (c.outputTokens ?? 0), s: Math.round((c.ms ?? 0) / 1000) })), [{ key: 'step' }, { key: 'agent' }, { key: 'provider' }, { key: 'ok', max: 40 }, { key: 'tokens' }, { key: 's' }]),
            ...(Object.keys(t.board).length ? ['', 'team notes:', ...Object.entries(t.board).map(([k, v]) => `  ${k} (${v.by}): ${v.value.slice(0, 120)}`)] : []),
          ].join('\n'),
        );
      }),
    );
}
