import type { Command } from 'commander';
import { PRODUCT, getPath, getSettings, overview, recentEvents, setSetting } from '@synaptome/core';
import { runDiagnostics } from '@synaptome/service';
import { CliError, EXIT, action, kv, table } from '../ctx';

export function registerSystem(program: Command) {
  program
    .command('status')
    .description('real system state: registry, discovery, installs, routing')
    .action(
      action((ctx) => {
        const o = overview(ctx.sys);
        ctx.out({ product: PRODUCT.name, version: PRODUCT.version, home: ctx.sys.home, ...o }, () =>
          [
            `${PRODUCT.name} ${PRODUCT.version}   home: ${ctx.sys.home}`,
            '',
            kv([
              ['capabilities', `${o.capabilities.total}  ${fmt(o.capabilities.byStatus)}`],
              ['candidates', `${o.candidates.total}  ${fmt(o.candidates.byState)}`],
              ['pending approval', o.pendingApproval],
              ['installed', `${o.installations.active} managed (${o.installations.real} in real host dirs), ${o.installations.external} pre-existing on host, ${o.installations.rolledBack} rolled back, ${o.installations.failed} failed`],
              ['security', `${o.security.blocked} blocked, ${o.security.criticalAudits} audits with critical findings`],
              ['routing', `${o.routing.decisions} decisions, ${o.routing.activations} activations, ${o.routing.openGaps} open gaps`],
              ['forge', `${o.forge.candidates} candidates, ${o.forge.evalRuns} eval runs`],
              ['last scan', o.lastScan ? `#${o.lastScan.id} ${o.lastScan.source_id} ${o.lastScan.mode} ${o.lastScan.status} found=${o.lastScan.found} new=${o.lastScan.added} (${o.lastScan.started_at})` : 'never'],
            ]),
            '',
            o.sources.length ? table(o.sources, [{ key: 'id' }, { key: 'kind' }, { key: 'health' }, { key: 'last_scan_at', title: 'last scan' }]) : 'no sources registered yet (run: synaptome sources)',
          ].join('\n'),
        );
      }),
    );

  program
    .command('doctor')
    .description('run diagnostics (exit 1 when a check fails)')
    .action(
      action((ctx) => {
        const checks = runDiagnostics(ctx.sys);
        const failed = checks.filter((c) => c.status === 'fail').length;
        ctx.out({ ok: failed === 0, failed, warnings: checks.filter((c) => c.status === 'warn').length, checks }, () =>
          checks.map((c) => `${{ ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' }[c.status]} ${c.label.padEnd(28)} ${c.detail}`).join('\n'),
        );
        if (failed) process.exitCode = EXIT.error;
      }),
    );

  program
    .command('events')
    .description('recent system events (append-only log)')
    .option('-n, --limit <n>', 'number of events', '30')
    .option('--type <prefix>', 'filter by event type prefix, e.g. scan. or install.')
    .action(
      action((ctx, opts: { limit: string; type?: string }) => {
        const ev = recentEvents(ctx.sys.db, Number(opts.limit) || 30, opts.type).reverse();
        ctx.out(ev, () => table(ev.map((e) => ({ id: e.id, ts: e.ts.slice(0, 19).replace('T', ' '), type: e.type, subject: e.subject ?? '', origin: e.origin ?? '' })), [{ key: 'id' }, { key: 'ts' }, { key: 'type', max: 34 }, { key: 'subject', max: 50 }, { key: 'origin' }]));
      }),
    );

  const config = program.command('config').description('read or change settings');
  config
    .command('get [key]')
    .description('show all settings or one dotted key')
    .action(
      action((ctx, key?: string) => {
        const s = getSettings(ctx.sys.db);
        const v = key ? getPath(s, key) : s;
        if (v === undefined) throw new CliError(`Unknown setting "${key}"`, EXIT.notFound);
        ctx.out(v, () => (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)));
      }),
    );
  config
    .command('set <key> <value>')
    .description('set a dotted key (value parsed as JSON when possible)')
    .action(
      action((ctx, key: string, value: string) => {
        let parsed: unknown = value;
        try {
          parsed = JSON.parse(value);
        } catch {
          /* keep as string */
        }
        try {
          setSetting(ctx.sys.db, key, parsed);
        } catch (e: any) {
          throw new CliError(e.message, EXIT.usage);
        }
        ctx.out({ ok: true, key, value: parsed }, () => `${key} = ${JSON.stringify(parsed)}`);
      }),
    );
}

const fmt = (o: Record<string, number>) => {
  const s = Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
  return s ? `(${s})` : '';
};
