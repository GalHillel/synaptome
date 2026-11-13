import type { Command } from 'commander';
import { buildProviders, checkProvider, providerStatus, selectProvider } from '@synaptome/providers';
import { CliError, EXIT, action, table } from '../ctx';

export function registerProviders(program: Command) {
  const p = program.command('providers').description('model providers: where task text can go, what is verified, what it costs');

  p.command('list', { isDefault: true }).description('every provider with its status (VERIFIED only after a recorded live call)').action(
    action((ctx) => {
      const rows = providerStatus(ctx.sys, buildProviders(ctx.sys));
      ctx.out(rows, () =>
        [
          table(rows.map((r) => ({ id: r.id, status: r.status, where: r.location === 'local' ? 'this machine' : 'leaves machine', billing: r.billing, model: r.model ?? '(not set)', use: !r.enabled ? 'switched off' : !r.allowedByPrivacy ? 'blocked by privacy' : 'allowed', last: r.lastCheck ? `${r.lastCheck.at.slice(0, 16).replace('T', ' ')} ${r.lastCheck.detail}` : '' })), [{ key: 'id' }, { key: 'status' }, { key: 'where' }, { key: 'billing' }, { key: 'model', max: 22 }, { key: 'use' }, { key: 'last', max: 60 }]),
          '',
          'Credentials are read from the environment when a call is made; Synaptome never stores them.',
          'Verify one with: synaptome providers test <id>',
        ].join('\n'),
      );
    }),
  );

  p.command('test <providerId>').description('availability check plus one tiny live call; the result becomes the provider status').action(
    action(async (ctx, id: string) => {
      const entry = buildProviders(ctx.sys).find((e) => e.spec.id === id);
      if (!entry) throw new CliError(`No provider "${id}"`, EXIT.notFound, 'list them with: synaptome providers');
      if (!ctx.json) process.stderr.write(`checking ${entry.spec.title}${entry.spec.location === 'remote' ? ' (sends one short test prompt off this machine)' : ''}...\n`);
      const r = await checkProvider(ctx.sys, entry);
      if (!r.ok) process.exitCode = EXIT.unavailable;
      ctx.out({ id, ...r }, () => `${id}: ${r.ok ? 'VERIFIED' : 'not verified'} — ${r.detail}`);
    }),
  );

  p.command('select').description('which provider a task would use now, and why the others were skipped').option('--local-only', 'only providers on this machine').action(
    action(async (ctx, opts: { localOnly?: boolean }) => {
      const r = await selectProvider(ctx.sys, buildProviders(ctx.sys), { localOnly: !!opts.localOnly });
      ctx.out({ selected: r.entry?.spec.id ?? null, reason: r.reason, considered: r.considered }, () => [`selected: ${r.entry ? r.reason : 'none'}${r.entry ? '' : ` (${r.reason})`}`, ...r.considered.map((c) => `  ${c.id.padEnd(22)} ${c.why}`)].join('\n'));
    }),
  );
}
