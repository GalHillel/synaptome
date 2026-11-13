import type { Command } from 'commander';
import { getCandidate, listCandidates } from '@synaptome/core';
import { buildConnectorRegistry } from '@synaptome/connectors';
import { type ScanReport, type SchedulerRun, checkSourceHealth, evaluationQueue, listSources, runDueJobs, runScheduler, scan, scanHistory, scheduleStatus, schedulePlan, setSourceBudget, setSourceEnabled, sourceChecks, sourceGate, syncSources } from '@synaptome/discovery';
import { listNotifications, markNotificationsRead } from '@synaptome/core';
import { CliError, EXIT, action, kv, table } from '../ctx';

export function registerDiscovery(program: Command) {
  const source = program.command('source').description('manage one discovery source: health history, budget, enable or disable');
  source
    .command('show <id>')
    .description('whether the source may be scanned now, its budget, and its recent checks')
    .action(
      action((ctx, id: string) => {
        const reg = buildConnectorRegistry(ctx.sys);
        syncSources(ctx.sys, reg);
        const gate = sourceGate(ctx.sys, reg.get(id));
        const checks = sourceChecks(ctx.sys, id, 10);
        ctx.out({ id, gate, checks }, () =>
          [
            kv([
              ['source', id],
              ['may scan now', gate.ok ? 'yes' : `no: ${gate.reason}`],
              ['consecutive failures', gate.failures],
              ['backing off until', gate.backoffUntil ?? '-'],
              ['terms', gate.terms ? `${gate.terms.allowed ? 'allowed' : 'disallowed'}: ${gate.terms.basis}` : 'not declared'],
              ['budget', Object.keys(gate.budget).length ? Object.entries(gate.budget).map(([k, v]) => `${k} ${v}`).join(', ') : 'none'],
              ['used today', `${gate.today.scans} scan(s), ${gate.today.requests} request(s)`],
            ]),
            '',
            'recent checks:',
            table(checks.map((c) => ({ ...c, ok: c.ok ? 'ok' : 'FAIL' })), [{ key: 'at', max: 24 }, { key: 'ok' }, { key: 'latencyMs', title: 'ms' }, { key: 'requests', title: 'req' }, { key: 'detail', max: 70 }]),
          ].join('\n'),
        );
      }),
    );
  for (const [verb, enabled] of [['enable', true], ['disable', false]] as const) {
    source
      .command(`${verb} <id>`)
      .description(`${verb} a source for every interface`)
      .action(
        action((ctx, id: string) => {
          syncSources(ctx.sys, buildConnectorRegistry(ctx.sys));
          setSourceEnabled(ctx.sys, id, enabled);
          ctx.out({ ok: true, id, enabled }, () => `${id} ${enabled ? 'enabled' : 'disabled'}`);
        }),
      );
  }
  source
    .command('budget <id>')
    .description('limit how much a source is used; omit every option to remove the budget')
    .option('--scans-per-day <n>', 'scans per UTC day')
    .option('--requests-per-day <n>', 'HTTP requests per UTC day (as reported by the connector)')
    .option('--max-per-scan <n>', 'items requested per scan')
    .action(
      action((ctx, id: string, opts: { scansPerDay?: string; requestsPerDay?: string; maxPerScan?: string }) => {
        syncSources(ctx.sys, buildConnectorRegistry(ctx.sys));
        const num = (v?: string) => (v == null ? undefined : Number(v));
        const b = setSourceBudget(ctx.sys, id, { scansPerDay: num(opts.scansPerDay), requestsPerDay: num(opts.requestsPerDay), maxPerScan: num(opts.maxPerScan) });
        ctx.out({ ok: true, id, budget: b }, () => (Object.keys(b).length ? `${id} budget: ${Object.entries(b).map(([k, v]) => `${k} ${v}`).join(', ')}` : `${id}: budget removed`));
      }),
    );

  const scheduler = program.command('scheduler').description('scheduled discovery and update checks, run in the foreground where you can see and stop them');
  scheduler
    .command('status')
    .description('every job, when it last ran, when it is next due, and anything holding it back')
    .action(
      action((ctx) => {
        const jobs = scheduleStatus(ctx.sys, buildConnectorRegistry(ctx.sys));
        ctx.out(jobs, () =>
          table(
            jobs.map((j) => ({ ...j, last: j.lastRun?.slice(0, 16).replace('T', ' ') ?? 'never', next: j.nextDue?.slice(0, 16).replace('T', ' ') ?? 'off', due: j.due ? 'yes' : '', waiting: j.waiting ?? '' })),
            [{ key: 'id', max: 34 }, { key: 'cadence' }, { key: 'last' }, { key: 'next' }, { key: 'due' }, { key: 'waiting', max: 60 }],
          ),
        );
      }),
    );
  scheduler
    .command('run')
    .description('run due jobs now, then keep checking until stopped (Ctrl+C); --once runs a single pass')
    .option('--once', 'run one pass and exit')
    .option('--interval <minutes>', 'minutes between passes', '5')
    .option('-n, --limit <n>', 'items per scan and update checks per pass')
    .action(
      action(async (ctx, opts: { once?: boolean; interval: string; limit?: string }) => {
        const reg = buildConnectorRegistry(ctx.sys);
        const limit = opts.limit ? Number(opts.limit) : undefined;
        const print = (r: SchedulerRun) => {
          if (ctx.json) return;
          process.stdout.write(r.ran.length ? r.ran.map((x) => `${r.at.slice(0, 19).replace('T', ' ')}  ${x.job}: ${x.status}  ${x.detail}`).join('\n') + '\n' : `${r.at.slice(0, 19).replace('T', ' ')}  nothing due\n`);
        };
        if (opts.once) {
          const r = await runDueJobs(ctx.sys, reg, { limit });
          if (ctx.json) ctx.out(r, () => '');
          else print(r);
          return;
        }
        const minutes = Number(opts.interval);
        if (!(minutes >= 1)) throw new CliError('--interval must be at least 1 minute', EXIT.usage);
        const stop = new AbortController();
        process.once('SIGINT', () => stop.abort());
        process.stderr.write(`scheduler running in the foreground, checking every ${minutes} minute(s); press Ctrl+C to stop\n`);
        await runScheduler(ctx.sys, reg, { intervalMs: minutes * 60_000, signal: stop.signal, onRun: print, limit });
        process.stderr.write('scheduler stopped\n');
      }),
    );

  program
    .command('notifications')
    .description('things that need a look: failing sources, updates, licence or publisher changes')
    .option('--all', 'include read notifications')
    .option('--read <id>', 'mark one as read')
    .option('--read-all', 'mark all as read')
    .action(
      action((ctx, opts: { all?: boolean; read?: string; readAll?: boolean }) => {
        if (opts.read || opts.readAll) {
          const n = markNotificationsRead(ctx.sys, opts.readAll ? undefined : Number(opts.read));
          return ctx.out({ ok: true, marked: n }, () => `${n} marked as read`);
        }
        const rows = listNotifications(ctx.sys, { unreadOnly: !opts.all });
        ctx.out(rows, () => (rows.length ? table(rows.map((r) => ({ ...r, when: r.ts.slice(0, 16).replace('T', ' '), read: r.readAt ? 'yes' : '' })), [{ key: 'id' }, { key: 'when' }, { key: 'level' }, { key: 'subject', max: 24 }, { key: 'title', max: 60 }, { key: 'read' }]) : 'nothing needs a look'));
      }),
    );

  program
    .command('sources')
    .description('discovery sources, their health and policy status')
    .option('--check', 'probe each source now')
    .action(
      action(async (ctx, opts: { check?: boolean }) => {
        const reg = buildConnectorRegistry(ctx.sys);
        syncSources(ctx.sys, reg);
        if (opts.check) for (const c of reg.list()) await checkSourceHealth(ctx.sys, c);
        const rows = listSources(ctx.sys, reg);
        ctx.out(rows, () => table(rows.map((r) => ({ ...r, official: r.official ? 'yes' : '', enabled: r.enabled ? 'yes' : 'no', detail: r.healthDetail ?? '' })), [{ key: 'id' }, { key: 'kind' }, { key: 'official' }, { key: 'enabled' }, { key: 'health' }, { key: 'candidates', title: 'cand.' }, { key: 'lastScanAt', title: 'last scan', max: 20 }, { key: 'detail', max: 70 }]));
      }),
    );

  program
    .command('scan')
    .description('discover capabilities (broad, incremental, or need-driven)')
    .option('-s, --source <id...>', 'limit to these sources (default: github and mcp-registry)')
    .option('-m, --mode <mode>', 'broad | incremental | need', 'broad')
    .option('-q, --query <text>', 'search text (implies --mode need unless a mode is given)')
    .option('--repo <owner/name>', 'inspect one GitHub repository directly')
    .option('-n, --limit <n>', 'maximum candidates per source')
    .action(
      action(async (ctx, opts: { source?: string[]; mode: string; query?: string; repo?: string; limit?: string }, cmd: Command) => {
        const modeGiven = cmd.getOptionValueSource('mode') === 'cli';
        const mode = (opts.repo ? 'need' : opts.query && !modeGiven ? 'need' : opts.mode) as 'broad' | 'incremental' | 'need';
        if (!['broad', 'incremental', 'need'].includes(mode)) throw new CliError(`Invalid --mode "${opts.mode}"`, EXIT.usage, 'use broad, incremental or need');
        if (mode === 'need' && !opts.query && !opts.repo) throw new CliError('--mode need requires --query or --repo', EXIT.usage);
        if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new CliError(`Invalid --repo "${opts.repo}"`, EXIT.usage, 'expected owner/name');
        const reg = buildConnectorRegistry(ctx.sys);
        syncSources(ctx.sys, reg);
        const ids = opts.repo ? ['github'] : opts.source ?? ['github', 'mcp-registry'];
        const reports: ScanReport[] = [];
        for (const id of ids) {
          let c;
          try {
            c = reg.get(id);
          } catch (e: any) {
            throw new CliError(e.message, EXIT.notFound);
          }
          if (!ctx.json) process.stderr.write(`scanning ${id} (${mode})...\n`);
          reports.push(await scan(ctx.sys, c, { mode, query: opts.repo ? `repo:${opts.repo}` : opts.query, limit: opts.limit ? Number(opts.limit) : undefined, origin: 'cli' }));
        }
        ctx.out({ ok: reports.every((r) => r.status !== 'failed'), reports }, () =>
          reports
            .map((r) => [`${r.sourceId}: ${r.status}  found=${r.found} new=${r.added} updated=${r.updated} unchanged=${r.unchanged} queued-for-evaluation=${r.queued}${r.error ? `\n  error: ${r.error}` : ''}`, ...r.notes.map((n) => `  - ${n}`)].join('\n'))
            .join('\n'),
        );
        if (reports.some((r) => r.status === 'failed')) process.exitCode = reports.every((r) => r.status === 'failed') ? EXIT.unavailable : EXIT.ok;
      }),
    );

  program
    .command('candidates')
    .description('discovered candidates (ranked)')
    .option('--state <state>', 'discovered | queued | quarantined | audited | registered | rejected | blocked')
    .option('-s, --source <id>', 'filter by source')
    .option('-k, --kind <kind>', 'filter by kind')
    .option('-q, --query <text>', 'filter by text')
    .option('--queue', 'show the evaluation queue only')
    .option('--local', 'include the local host inventory (hidden by default)')
    .option('-n, --limit <n>', 'rows', '30')
    .action(
      action((ctx, opts: { state?: string; source?: string; kind?: string; query?: string; queue?: boolean; local?: boolean; limit: string }) => {
        let items = opts.queue ? evaluationQueue(ctx.sys, Number(opts.limit)) : listCandidates(ctx.sys, { state: opts.state, source: opts.source, kind: opts.kind, q: opts.query, limit: 500 }).items;
        if (!opts.local && !opts.source) items = items.filter((c) => c.sourceId !== 'local-claude');
        const total = items.length;
        items = items.slice(0, Number(opts.limit) || 30);
        ctx.out({ total, items }, () => `${total} candidate(s)\n` + table(items.map((c) => ({ id: c.id, rank: c.rank.toFixed(0), kind: c.kind, name: c.name, source: c.sourceId, state: c.state, licence: c.licenseSpdx ?? '?', action: c.recommendedAction ?? '', upd: c.updateAvailable ? 'yes' : '' })), [{ key: 'id' }, { key: 'rank' }, { key: 'kind' }, { key: 'name', max: 34 }, { key: 'source' }, { key: 'state' }, { key: 'licence' }, { key: 'action' }, { key: 'upd' }]));
      }),
    );

  program
    .command('candidate <id>')
    .description('full normalized record of one candidate')
    .action(
      action((ctx, id: string) => {
        const c = getCandidate(ctx.sys, id);
        if (!c) throw new CliError(`No candidate "${id}"`, EXIT.notFound, 'list ids with: synaptome candidates');
        const audit = ctx.sys.db.get<any>('SELECT * FROM audits WHERE subject_id=? ORDER BY id DESC LIMIT 1', id);
        ctx.out({ ...c, audit: audit ? { ...audit, findings: JSON.parse(audit.findings), license: JSON.parse(audit.license ?? 'null') } : null }, () =>
          [
            kv([['id', c.id], ['name', c.name], ['kind', c.kind], ['state', c.state], ['source', `${c.sourceId}  (${c.externalId})`], ['url', c.url], ['pinned ref', c.ref], ['publisher', c.publisher], ['licence', `${c.licenseSpdx ?? 'unknown'} — ${c.licenseEvidence ?? 'no evidence yet'}`], ['rank', `${c.rank} (triage order, not quality)`], ['next action', c.recommendedAction], ['duplicate of', c.duplicateOf ?? '-'], ['update', c.updateAvailable ? 'upstream changed since audit' : 'none detected'], ['description', c.description]]),
            '', 'rank reasons:', ...c.rankReasons.map((r) => `  ${r}`),
            ...(c.overlap.length ? ['', 'possible overlap:', ...c.overlap.map((o) => `  ${o.id}  ${o.name}  (${o.similarity}) ${o.basis}`)] : []),
            ...(c.files.length ? ['', `files (${c.files.length}):`, ...c.files.slice(0, 25).map((f) => `  ${f.path}  ${f.size}b`)] : []),
          ].join('\n'),
        );
      }),
    );

  program
    .command('scans')
    .description('discovery history')
    .option('-n, --limit <n>', 'rows', '15')
    .action(
      action((ctx, opts: { limit: string }) => {
        const rows = scanHistory(ctx.sys, Number(opts.limit) || 15);
        ctx.out(rows, () => table(rows.map((r) => ({ ...r, started: String(r.started_at).slice(0, 19).replace('T', ' ') })), [{ key: 'id' }, { key: 'started' }, { key: 'source_id', title: 'source' }, { key: 'mode' }, { key: 'query', max: 26 }, { key: 'status' }, { key: 'found' }, { key: 'added', title: 'new' }, { key: 'updated', title: 'upd' }, { key: 'error', max: 40 }]));
      }),
    );

  program
    .command('schedule')
    .description('show the scheduled-scan tasks Synaptome would register (nothing is created without --install --yes)')
    .option('--install', 'register the tasks with Windows Task Scheduler')
    .option('--remove', 'remove the tasks')
    .option('--yes', 'confirm --install / --remove')
    .action(
      action(async (ctx, opts: { install?: boolean; remove?: boolean; yes?: boolean }) => {
        const plan = schedulePlan('synaptome', ctx.sys.settings());
        if ((opts.install || opts.remove) && !opts.yes) throw new CliError('Changing scheduled tasks needs --yes', EXIT.blocked, 'review the plan with: synaptome schedule');
        if (opts.install || opts.remove) {
          if (process.platform !== 'win32') throw new CliError('Automatic registration is implemented for Windows Task Scheduler only', EXIT.unavailable, 'add the printed cron lines manually');
          const { spawnSync } = await import('node:child_process');
          const results = plan.map((t) => {
            const r = spawnSync(opts.install ? t.windows.create : t.windows.remove, { shell: true, encoding: 'utf8' });
            return { task: t.name, ok: r.status === 0, output: (r.stdout || r.stderr).trim() };
          });
          ctx.out({ action: opts.install ? 'install' : 'remove', results }, () => results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.task}: ${r.output}`).join('\n'));
          return;
        }
        ctx.out({ registered: false, plan }, () => ['Not registered. These visible tasks would be created by `synaptome schedule --install --yes`:', '', ...plan.flatMap((t) => [`${t.name}  (${t.schedule})`, `  ${t.windows.create}`, ''])].join('\n'));
      }),
    );
}
