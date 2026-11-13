import path from 'node:path';
import type { Command } from 'commander';
import { LEGACY, MigrationError, PRODUCT, defaultHome, exportPostMigrationDelta, migrateHome, postMigrationDelta, readMigrationMarker, resolveHome, rollbackMigration } from '@synaptome/core';
import { EXIT, kv } from '../ctx';

/**
 * `migrate` deliberately does not open the system: opening would create the destination home before the
 * migration has a chance to build it.
 */
export function registerMigrate(program: Command) {
  program
    .command('migrate')
    .description(`copy a ${LEGACY.name} home to a ${PRODUCT.name} home (the original is never modified)`)
    .option('--from <dir>', `source home (default: the ${LEGACY.name} home from the environment or its default location)`)
    .option('--to <dir>', `destination home (default: --home, the environment, or the ${PRODUCT.name} default location)`)
    .option('--dry-run', 'report what would be copied without writing anything')
    .option('--status', 'show whether the destination was migrated and what changed since')
    .option('--rollback', 'undo the migration; refuses if data was created afterwards')
    .option('--export-delta', 'write the rows created since the migration to a JSON file')
    .option('--discard-new-data', 'with --rollback: set the migrated home aside even though it has new data')
    .option('--confirm <name>', 'with --discard-new-data: the destination directory name, typed out')
    .action(async (opts: { from?: string; to?: string; dryRun?: boolean; status?: boolean; rollback?: boolean; exportDelta?: boolean; discardNewData?: boolean; confirm?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals();
      const json = !!g.json;
      const out = (data: unknown, human: string): void => {
        process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : human + '\n');
      };
      const to = path.resolve(opts.to ?? resolveHome(g.home));
      const from = path.resolve(opts.from ?? process.env[`${LEGACY.envPrefix}_HOME`] ?? defaultHome(LEGACY.dataDir));
      try {
        if (opts.status) {
          const marker = readMigrationMarker(to);
          if (!marker) return out({ migrated: false, to }, `${to} was not created by a migration`);
          const delta = postMigrationDelta(to);
          const changes = Object.entries(delta.tables).map(([t, v]) => `${t} ${v.atMigration}→${v.now}`).join(', ') || 'files';
          return out({ migrated: true, to, marker, delta }, kv([['home', to], ['migrated from', marker.migratedFrom], ['at', marker.at], ['changed since', delta.changed ? `yes: ${changes}` : 'no']]));
        }
        if (opts.exportDelta) {
          const r = exportPostMigrationDelta(to);
          return out(r, `exported ${r.rows} row(s) created since the migration to ${r.file}`);
        }
        if (opts.rollback) {
          const r = rollbackMigration(to, { discardNewData: opts.discardNewData, confirm: opts.confirm });
          return out(r, r.status === 'rolled-back' ? `rolled back: removed ${r.to}; the original home ${r.source} is intact` : `set aside, not deleted: ${r.preservedAt}\nthe original home ${r.source} is intact`);
        }
        const r = await migrateHome({ from, to, dryRun: opts.dryRun });
        const headline = r.status === 'already-migrated' ? `already migrated on ${r.at}; nothing to do` : r.status === 'dry-run' ? 'dry run: nothing was written' : 'migration complete';
        const body = kv([
          ['from', r.from],
          ['to', r.to],
          ['rows', `${r.rows} in ${Object.keys(r.tables).length} tables`],
          ['files', r.files],
          ['snapshots verified', r.snapshotsVerified],
          ['renamed files', r.renamedFiles],
          ['path values updated', r.rewrittenPathValues],
          ['integrity', r.integrity],
          ['source', r.source.concurrentWrites ? 'another process wrote to it during the copy; the copy is one consistent snapshot' : 'database bytes identical before and after'],
        ]);
        const tail = r.status === 'migrated' ? `\nthe original home was not modified. Use the new one with: ${PRODUCT.bin} --home "${r.to}" status` : '';
        out(r, [headline, body, tail].filter(Boolean).join('\n'));
      } catch (e: any) {
        const blocked = ['post-migration-data', 'confirmation-required', 'destination-not-empty'];
        const missing = ['source-missing', 'not-migrated', 'source-not-a-home'];
        const code = e instanceof MigrationError ? (blocked.includes(e.code) ? EXIT.blocked : missing.includes(e.code) ? EXIT.notFound : EXIT.error) : EXIT.error;
        const hint =
          e instanceof MigrationError && e.code === 'post-migration-data'
            ? `keep it (do nothing), or export the new rows: ${PRODUCT.bin} migrate --to "${to}" --export-delta, or set it aside: ${PRODUCT.bin} migrate --to "${to}" --rollback --discard-new-data --confirm ${path.basename(to)}`
            : undefined;
        if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: e?.code ?? code, message: e?.message ?? String(e), hint, data: e?.details } }, null, 2) + '\n');
        else process.stderr.write(`error: ${e?.message ?? e}${hint ? `\n  hint: ${hint}` : ''}\n`);
        process.exitCode = code;
      }
    });
}
