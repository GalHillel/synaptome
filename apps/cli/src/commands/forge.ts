import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { type CaseKind, EvalSetError, type Split, addEvalCases, claudeCliProvider, evalSetSummary, importedRunner, listEvalCases, listEvals, modelRunner, removeEvalCase } from '@synaptome/evaluation';
import { ForgeError, type ForgeCandidate, forgeAuthor, forgeAuthorHeldout, forgeCases, forgeDeprecate, forgeRollback, forgeCheck, forgeDecide, forgeEvaluate, forgeNew, forgeRevise, forgeVariants, getForge, listForge } from '@synaptome/forge';
import { PRODUCT } from '@synaptome/core';
import { recordHostContext, renderHostContext, routeTask } from '@synaptome/router';
import { CliError, EXIT, action, kv, table } from '../ctx';
import { depsFor } from './acquisition';

async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ForgeError) throw new CliError(e.message, e.code === 'not-found' ? EXIT.notFound : e.code === 'state' ? EXIT.blocked : EXIT.usage, e.hint);
    if (e instanceof EvalSetError) throw new CliError(e.message, EXIT.blocked);
    throw e;
  }
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
function show(c: ForgeCandidate): string {
  const r = c.record;
  return [
    kv([['id', c.id], ['name', c.name], ['state', c.state], ['gap', c.gap], ['capability', c.capabilityId], ['author', r.author], ['workspace', c.path]]),
    '', `alternatives considered (${r.alternatives.length}):`, ...r.alternatives.map((a) => `  ${a.where}: ${a.name} [${a.id}] ${a.note}`),
    '', r.lint ? `structure: ${r.lint.ok ? 'pass' : 'FAIL'}${r.lint.problems.length ? '\n' + r.lint.problems.map((p) => `  - ${p}`).join('\n') : ''}` : 'structure: not checked',
    r.audit ? `security: ${r.audit.summary}` : 'security: not screened',
    r.activation ? [`activation: positives ${pct(r.activation.positiveRate)}, negatives ${pct(r.activation.negativeRate)}`, ...r.activation.positives.map((p) => `  ${p.passed ? '[pass]' : '[FAIL]'} should route:     ${p.prompt}`), ...r.activation.negatives.map((p) => `  ${p.passed ? '[pass]' : '[FAIL]'} should NOT route: ${p.prompt}`)].join('\n') : 'activation: not tested',
    r.baseline ? (r.baseline.status === 'blocked' ? `baseline: BLOCKED (${r.baseline.runner}) — ${r.baseline.blocker}` : [`baseline (${r.baseline.runner}, eval #${r.baseline.evalId}): ${r.baseline.summary!.variants.map((v) => `${v.variant} ${v.passed}/${v.total}`).join(', ')}; lift ${r.baseline.summary!.lift}`, ...(['train', 'heldout'] as const).filter((k) => r.baseline!.splits?.[k]).map((k) => `  ${k === 'heldout' ? 'held-out' : 'training'}: ${r.baseline!.splits![k]!.variants.map((v) => `${v.variant} ${v.passed}/${v.total}`).join(', ')}; lift ${r.baseline!.splits![k]!.lift}`), `  ${r.baseline.summary!.note}`].join('\n')) : 'baseline: not run',
    r.versions?.length ? `promoted versions: ${r.versions.map((v) => `${v.contentHash.slice(0, 12)} (held-out ${pct(v.heldout.withSkill)} vs ${pct(v.heldout.baseline)}, n=${v.heldout.n})`).join(' -> ')}` : '',
    r.gate ? `gate: ${r.gate.decision}${r.gate.failed.length ? ` (${r.gate.failed.join(', ')})` : ''}` : '',
    c.decision ? ['', `DECISION: ${c.decision.verdict.toUpperCase()} at ${c.decision.at}`, ...c.decision.reasons.map((x) => `  - ${x}`)].join('\n') : '',
  ].filter((l) => l !== '').join('\n');
}

export function registerForge(program: Command) {
  const forge = program.command('forge').description('Skill Forge: turn a capability gap into a tested, evaluated skill');
  forge.command('list', { isDefault: true }).description('forge candidates and their state').action(
    action((ctx) => {
      const rows = listForge(ctx.sys);
      ctx.out(rows, () => (rows.length ? table(rows.map((c) => ({ id: c.id, state: c.state, gap: c.gap, verdict: c.decision?.verdict ?? '', author: c.record.author })), [{ key: 'id', max: 40 }, { key: 'state' }, { key: 'gap', max: 34 }, { key: 'verdict' }, { key: 'author' }]) : 'no forge candidates yet. See open gaps with: synaptome gaps'));
    }),
  );
  forge
    .command('new <gap>')
    .description('create a draft workspace for a gap (term or gap id); searches existing alternatives first')
    .option('--name <name>', 'skill name')
    .option('--author <who>', 'who will write it', 'host-agent')
    .action(action(async (ctx, gap: string, opts: { name?: string; author: string }) => { const c = await guard(() => forgeNew(ctx.sys, { gap, name: opts.name, author: opts.author })); ctx.out(c, () => `${show(c)}\n\nnext: write SKILL.md and the evals in the workspace, then: synaptome forge check ${c.id}`); }));
  forge.command('show <id>').description('everything recorded about one candidate').action(action(async (ctx, id: string) => { const c = await guard(() => getForge(ctx.sys, id)); ctx.out(c, () => show(c)); }));
  forge.command('author <id>').description('ask the model provider to write SKILL.md from the brief').action(
    action(async (ctx, id: string) => {
      const r = await guard(() => forgeAuthor(ctx.sys, id, claudeCliProvider()));
      ctx.out(r, () => `${r.status}: ${r.detail}`);
      if (r.status === 'blocked') process.exitCode = EXIT.unavailable;
    }),
  );
  forge.command('check <id>').description('structural lint, security screening, positive and negative activation tests').action(action(async (ctx, id: string) => { const c = await guard(() => forgeCheck(ctx.sys, depsFor(ctx.sys), id)); ctx.out(c, () => show(c)); if (c.state !== 'checked') process.exitCode = EXIT.error; }));
  forge
    .command('export-evals <id> <dir>')
    .description('write each evaluation prompt (per variant) to files so an external agent can answer them')
    .action(
      action(async (ctx, id: string, dir: string) => {
        const c = await guard(() => getForge(ctx.sys, id));
        const out = path.resolve(dir);
        const cases = forgeCases(c, ctx.sys);
        for (const v of forgeVariants(c)) {
          fs.mkdirSync(path.join(out, 'prompts', v.id), { recursive: true });
          fs.mkdirSync(path.join(out, v.id), { recursive: true });
          for (const k of cases) fs.writeFileSync(path.join(out, 'prompts', v.id, `${k.id}.md`), `${v.system ? `<system>\n${v.system}\n</system>\n\n` : ''}${k.prompt}\n`);
        }
        ctx.out({ dir: out, cases: cases.length, variants: ['baseline', 'with-skill'] }, () => `wrote ${cases.length * 2} prompt file(s) under ${path.join(out, 'prompts')}\nsave each answer as ${out}${path.sep}<variant>${path.sep}<caseId>.md, then:\n  synaptome forge eval ${c.id} --from "${out}" --produced-by <label>`);
      }),
    );
  forge
    .command('eval <id>')
    .description('baseline comparison: same cases with and without the skill, graded deterministically')
    .option('--from <dir>', 'grade transcripts produced by an external agent (see export-evals)')
    .option('--produced-by <label>', 'who produced the transcripts', 'external-agent')
    .option('--model <model>', 'model for the headless Claude runner')
    .action(
      action(async (ctx, id: string, opts: { from?: string; producedBy: string; model?: string }) => {
        const runner = opts.from ? importedRunner(path.resolve(opts.from), opts.producedBy) : modelRunner(claudeCliProvider({ model: opts.model }));
        if (!ctx.json) process.stderr.write(`running baseline evaluation with ${runner.id}...\n`);
        const c = await guard(() => forgeEvaluate(ctx.sys, id, runner));
        ctx.out(c, () => show(c));
        if (c.state === 'eval-blocked') process.exitCode = EXIT.unavailable;
      }),
    );
  forge
    .command('revise <id>')
    .description('reopen a decided candidate; a promoted skill leaves routing until it passes again')
    .requiredOption('-r, --reason <text>', 'why it is being revised')
    .action(action(async (ctx, id: string, opts: { reason: string }) => { const c = await guard(() => forgeRevise(ctx.sys, id, opts.reason)); ctx.out(c, () => `${c.id} reopened as draft. Its capability is out of routing until it passes again.\nworkspace: ${c.path}`); }));
  forge
    .command('heldout <id>')
    .description('ask a separate model run, which never sees the skill, to write held-out cases (recorded as a different author)')
    .option('-n, --cases <n>', 'behaviour cases to request', '12')
    .option('--model <model>', 'model for the headless Claude provider')
    .action(
      action(async (ctx, id: string, opts: { cases: string; model?: string }) => {
        const r = await guard(() => forgeAuthorHeldout(ctx.sys, id, claudeCliProvider({ model: opts.model }), { behaviour: Number(opts.cases) || 12 }));
        ctx.out(r, () => `${r.status}: ${r.detail}`);
        if (r.status === 'blocked') process.exitCode = EXIT.unavailable;
      }),
    );
  forge
    .command('deprecate <id>')
    .description('take a promoted skill out of routing for good (its versions and evidence stay on record)')
    .requiredOption('-r, --reason <text>', 'why')
    .action(action(async (ctx, id: string, opts: { reason: string }) => { const c = await guard(() => forgeDeprecate(ctx.sys, id, opts.reason)); ctx.out(c, () => show(c)); }));
  forge
    .command('rollback <id>')
    .description('return to the previously promoted version (files, registry and sandbox install)')
    .action(action(async (ctx, id: string) => { const c = await guard(() => forgeRollback(ctx.sys, depsFor(ctx.sys), id)); ctx.out(c, () => show(c)); }));
  forge
    .command('decide <id>')
    .description('promote, reject or hold according to the recorded evidence')
    .option('--reject <reason>', 'reject regardless of results')
    .action(action(async (ctx, id: string, opts: { reject?: string }) => { const c = await guard(() => forgeDecide(ctx.sys, depsFor(ctx.sys), id, opts)); ctx.out(c, () => show(c)); }));

  const es = program.command('evalset').description('evaluation cases: train/held-out split and who wrote each case');
  const forgeOf = (sys: any, id: string) => (id.includes('.') ? null : getForge(sys, id));
  es.command('show <id>').description('counts by split and kind, authors, and every case (id: forge candidate or capability id)').option('--split <split>', 'train or heldout').action(
    action(async (ctx, id: string, opts: { split?: Split }) => {
      const sid = (await guard(() => forgeOf(ctx.sys, id)))?.capabilityId ?? id;
      const sum = evalSetSummary(ctx.sys, sid);
      const rows = listEvalCases(ctx.sys, sid, { split: opts.split });
      ctx.out({ summary: sum, cases: rows }, () => [kv([['subject', sid], ['training', `${sum.train.positive} positive, ${sum.train.negative} negative, ${sum.train.behaviour} behaviour`], ['held-out', `${sum.heldout.positive} positive, ${sum.heldout.negative} negative, ${sum.heldout.behaviour} behaviour`]]), '', 'authors:', ...sum.authors.map((a) => `  ${a.author}: ${a.cases} case(s) in ${a.splits.join(', ')}`), '', table(rows.map((r) => ({ id: r.id, split: r.split, kind: r.kind, prompt: r.prompt, must: r.must.join(' | ') })), [{ key: 'id' }, { key: 'split' }, { key: 'kind' }, { key: 'prompt', max: 60 }, { key: 'must', max: 30 }])].join('\n'));
    }),
  );
  const collectAll = (v: string, prev: string[]) => [...prev, v];
  es.command('add <id>')
    .description('add one case (held-out cases must not come from the run that wrote the skill)')
    .requiredOption('--prompt <text>', 'the request')
    .option('--kind <kind>', 'positive, negative or behaviour', 'behaviour')
    .option('--split <split>', 'train or heldout', 'heldout')
    .option('--must <regex>', 'a pattern a correct answer must contain (repeatable)', collectAll, [])
    .option('--must-not <regex>', 'a pattern a correct answer must not contain (repeatable)', collectAll, [])
    .option('--author <who>', 'who wrote it', 'person')
    .action(
      action(async (ctx, id: string, o: { prompt: string; kind: CaseKind; split: Split; must: string[]; mustNot: string[]; author: string }) => {
        const c = await guard(() => forgeOf(ctx.sys, id));
        const r = await guard(() => addEvalCases(ctx.sys, c?.capabilityId ?? id, [{ kind: o.kind, prompt: o.prompt, must: o.must, mustNot: o.mustNot }], { split: o.split, author: o.author, generatedBy: c?.record.generatedBy ?? null }));
        if (!r.added) throw new CliError(`not added: ${r.rejected[0]?.why}`, EXIT.usage);
        ctx.out(r, () => `added 1 ${o.split} ${o.kind} case by ${o.author}`);
      }),
    );
  es.command('import <id> <file>')
    .description('add cases from a JSON array of {kind?, prompt, must?, mustNot?}')
    .option('--split <split>', 'train or heldout', 'heldout')
    .option('--author <who>', 'who wrote them', 'person')
    .action(
      action(async (ctx, id: string, file: string, o: { split: Split; author: string }) => {
        const c = await guard(() => forgeOf(ctx.sys, id));
        let arr: any[];
        try {
          arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e: any) {
          throw new CliError(`${file}: ${e.message}`, EXIT.usage);
        }
        const r = await guard(() => addEvalCases(ctx.sys, c?.capabilityId ?? id, arr.map((x) => ({ kind: x.kind ?? 'behaviour', prompt: x.prompt, must: x.must, mustNot: x.mustNot, id: x.id })), { split: o.split, author: o.author, generatedBy: c?.record.generatedBy ?? null }));
        ctx.out(r, () => [`added ${r.added} ${o.split} case(s) by ${o.author}`, ...r.rejected.map((x) => `  rejected: ${x.prompt} - ${x.why}`)].join('\n'));
      }),
    );
  es.command('remove <id> <caseId>').description('remove one case').action(
    action(async (ctx, id: string, caseId: string) => {
      const sid = (await guard(() => forgeOf(ctx.sys, id)))?.capabilityId ?? id;
      if (!removeEvalCase(ctx.sys, sid, caseId)) throw new CliError(`No case "${caseId}" in ${sid}`, EXIT.notFound);
      ctx.out({ removed: caseId }, () => `removed ${caseId}`);
    }),
  );

  program
    .command('eval [subjectId]')
    .description('recorded evaluation runs (functional, activation, baseline)')
    .option('-n, --limit <n>', 'rows', '25')
    .action(
      action((ctx, subjectId: string | undefined, opts: { limit: string }) => {
        const rows = listEvals(ctx.sys, subjectId, Number(opts.limit) || 25);
        ctx.out(rows, () => table(rows.map((e) => ({ id: e.id, when: e.createdAt.slice(0, 19).replace('T', ' '), subject: e.subjectId, suite: e.suite, runner: e.runner, status: e.status, summary: e.suite === 'baseline' && e.summary.variants ? e.summary.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(', ') : e.suite === 'activation' ? `pos ${pct(e.summary.positiveRate)} neg ${pct(e.summary.negativeRate)}` : e.summary.detail ?? e.summary.blocker ?? '' })), [{ key: 'id' }, { key: 'when' }, { key: 'subject', max: 36 }, { key: 'suite' }, { key: 'runner', max: 26 }, { key: 'status' }, { key: 'summary', max: 60 }]));
      }),
    );

  /**
   * Claude Code UserPromptSubmit hook. Reads the hook payload on stdin, routes the prompt, and returns
   * the top capability as additional context. Prints nothing for small or unmatched prompts.
   */
  program
    .command('hook <event>')
    .description('host hook entry point (user-prompt). Reads the hook JSON payload on stdin')
    .action(
      action(async (ctx, event: string) => {
        if (event !== 'user-prompt') throw new CliError(`Unknown hook event "${event}"`, EXIT.usage);
        // A model call Synaptome itself made (forge, agents, evaluation): never route our own prompts.
        if (process.env.SYNAPTOME_INTERNAL_CALL === '1') return;
        let raw = '';
        for await (const chunk of process.stdin) raw += chunk;
        let prompt = '';
        try {
          prompt = String(JSON.parse(raw).prompt ?? '');
        } catch {
          return; // not a hook payload: stay silent, never break the host
        }
        const started = performance.now();
        // Host-added wrappers are not the user's words and must not steer routing.
        const text = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim();
        if (text.length < 12 || text.startsWith('/')) return;
        let d;
        try {
          d = routeTask(ctx.sys, text, { origin: 'hook' });
        } catch {
          return; // a routing failure must never block or disturb the user's prompt
        }
        // Summaries only. The full capability is loaded on demand, and only that load counts as an activation.
        const fwd = (p: string) => p.replace(/\\/g, '/');
        const launcher = process.argv[1] ? `node "${fwd(process.argv[1])}" --home "${fwd(ctx.sys.home)}"` : PRODUCT.bin;
        const sent = renderHostContext(ctx.sys, d, { loadNote: `To load one: MCP tool get_capability, or run: ${launcher} activate <id> --decision ${d.id}` });
        recordHostContext(ctx.sys, d.id, { injectedTokens: sent.tokens, injectedBytes: Buffer.byteLength(sent.text), offered: sent.offered, hookMs: Number((performance.now() - started).toFixed(1)) });
        if (!sent.text) return; // nothing qualified: add nothing to the host's context
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: sent.text } }) + '\n');
      }),
    );
}
