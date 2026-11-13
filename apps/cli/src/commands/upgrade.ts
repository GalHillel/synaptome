import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import type { Command } from 'commander';
import { Db, PRODUCT, emit } from '@synaptome/core';
import { CliError, type Ctx, EXIT, action, kv } from '../ctx';
import { launcherPath } from './routing';

/**
 * Upgrading an installed copy (Phase 10 S4). Before anything changes, the running version is packed into
 * `<home>/versions/` and the database is copied with SQLite's online backup; the new version is installed into the
 * same place with npm and must pass `doctor` on this home, or the previous version and database are put back.
 * `upgrade --rollback` returns to the previous version. It keeps the current database when the schema did not change;
 * when it did, the pre-upgrade copy can only replace it if nothing was recorded since the upgrade, or when asked by
 * name (--discard-newer-data), and the current database is copied to backups first either way.
 */

export interface Installation { pkgDir: string; prefix: string; layout: 'local' | 'global'; version: string }
export interface UpgradeRecord {
  from: string; to: string | null; spec: string; fromSchema: number; toSchema: number | null;
  previousPackage: string; dbBackup: string; eventsBefore: number; eventsAfter: number | null;
  prefix: string; layout: 'local' | 'global'; at: string; status: 'started' | 'completed' | 'failed-restored' | 'rolled-back'; detail?: string;
}

/** Where this copy is installed: `<prefix>/node_modules/synaptome/`. Null when it runs from a source checkout. */
export function locateInstallation(launcher = launcherPath()): Installation | null {
  const pkgDir = path.dirname(launcher);
  const pkgFile = path.join(pkgDir, 'package.json');
  if (path.basename(path.dirname(pkgDir)) !== 'node_modules' || !fs.existsSync(pkgFile)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (pkg.name !== PRODUCT.bin) return null;
  const prefix = path.dirname(path.dirname(pkgDir));
  // A local install puts the command in node_modules/.bin; a global one (npm -g) puts it in the prefix itself.
  const layout = fs.existsSync(path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? `${PRODUCT.bin}.cmd` : PRODUCT.bin)) ? 'local' : 'global';
  return { pkgDir, prefix, layout, version: pkg.version };
}

function npm(args: string[], cwd: string) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  if (fs.existsSync(cli)) return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env });
  // Only when npm's script is not beside Node: through the shell, so every argument must be free of shell syntax (T-06).
  const bad = args.find((a) => /["&|<>^%!`$;]/.test(a));
  if (bad) throw new CliError(`"${bad}" contains characters that cannot be passed to npm safely here`, EXIT.usage, 'use a package file path or a plain version spec such as synaptome@0.3.0');
  return spawnSync(['npm', ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' '), { cwd, encoding: 'utf8', env, shell: true });
}
function npmInstall(inst: Installation, spec: string) {
  const r = npm(['install', ...(inst.layout === 'global' ? ['--global'] : []), '--prefix', inst.prefix, spec, '--no-audit', '--no-fund'], inst.prefix);
  if (r.status !== 0) throw new Error(`npm install ${spec} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`);
}
/** Runs the installed copy (whatever version is there now) against this home. */
function runInstalled(inst: Installation, home: string, args: string[]) {
  const env = { ...process.env };
  delete env[`${PRODUCT.envPrefix}_LAUNCHER`];
  return spawnSync(process.execPath, [path.join(inst.pkgDir, `${PRODUCT.bin}.mjs`), '--home', home, ...args], { encoding: 'utf8', env });
}

const recordsFile = (home: string) => path.join(home, 'upgrades.json');
export const readRecords = (home: string): UpgradeRecord[] => (fs.existsSync(recordsFile(home)) ? JSON.parse(fs.readFileSync(recordsFile(home), 'utf8')) : []);
const saveRecords = (home: string, r: UpgradeRecord[]) => fs.writeFileSync(recordsFile(home), JSON.stringify(r, null, 2) + '\n');
const schemaOf = (db: Db) => db.get<{ v: number }>('SELECT MAX(version) v FROM schema_migrations')?.v ?? 0;
const lastEvent = (db: Db) => db.get<{ m: number }>('SELECT COALESCE(MAX(id),0) m FROM events')!.m;

/**
 * What a rollback must do with the database. Pure, so the rule is testable on its own:
 * - schema unchanged: keep the current database (the earlier version reads it; nothing is lost);
 * - schema changed, nothing recorded since the upgrade: put back the pre-upgrade copy;
 * - schema changed and something was recorded since: refuse, unless discarding was asked for by name.
 */
export function rollbackDatabasePlan(rec: Pick<UpgradeRecord, 'fromSchema' | 'eventsAfter'>, currentSchema: number, lastEventId: number, discardNewer: boolean): { action: 'keep' | 'restore' | 'refuse'; newerEvents: number } {
  const newerEvents = rec.eventsAfter == null ? 0 : Math.max(0, lastEventId - rec.eventsAfter);
  if (currentSchema <= rec.fromSchema) return { action: 'keep', newerEvents };
  if (newerEvents > 0 && !discardNewer) return { action: 'refuse', newerEvents };
  return { action: 'restore', newerEvents };
}

/** Replaces the database file with a copy, after copying the current one aside. The caller has closed every connection. */
function restoreDatabase(dbFile: string, from: string, backupsDir: string): string {
  const aside = path.join(backupsDir, `${PRODUCT.bin}-pre-rollback-${Date.now()}.db`);
  fs.copyFileSync(dbFile, aside);
  for (const s of ['-wal', '-shm']) if (fs.existsSync(dbFile + s)) fs.copyFileSync(dbFile + s, aside + s);
  for (const s of ['-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });
  fs.copyFileSync(from, dbFile);
  return aside;
}

export function registerUpgrade(program: Command) {
  program
    .command('upgrade [spec]')
    .description('upgrade this installed copy to another version (an npm version spec or a package file); keeps the previous version and a database copy for --rollback')
    .option('--rollback', 'return to the version before the last upgrade')
    .option('--discard-newer-data', 'with --rollback: allowed to replace a database that was changed after an upgrade that changed its schema (the current one is copied to backups first)')
    .option('--status', 'show the upgrade history of this home')
    .action(
      action(async (ctx, spec: string | undefined, opts: { rollback?: boolean; discardNewerData?: boolean; status?: boolean }) => {
        const records = readRecords(ctx.sys.home);
        if (opts.status || (!spec && !opts.rollback)) {
          const inst = locateInstallation();
          ctx.out({ installation: inst, records }, () => [kv([['running', `${PRODUCT.name} ${PRODUCT.version}`], ['installed in', inst ? `${inst.prefix} (${inst.layout})` : 'a source checkout (upgrade applies to installed copies)']]), '', ...(records.length ? records.map((r) => `${r.at.slice(0, 16).replace('T', ' ')}  ${r.from} -> ${r.to ?? r.spec}  ${r.status}${r.detail ? `  (${r.detail})` : ''}`) : ['no upgrades recorded'])].join('\n'));
          return;
        }
        const inst = locateInstallation();
        if (!inst) throw new CliError('This copy runs from a source checkout, not an installed package', EXIT.blocked, 'upgrade applies to a copy installed with npm; in a checkout use git');
        if (opts.rollback) return rollbackUpgrade(ctx, inst, records, !!opts.discardNewerData);
        return upgrade(ctx, inst, spec!, records);
      }),
    );
}

async function upgrade(ctx: Ctx, inst: Installation, spec: string, records: UpgradeRecord[]) {
  const sys = ctx.sys;
  const specArg = fs.existsSync(spec) ? path.resolve(spec) : spec;
  const versions = path.join(sys.home, 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(sys.paths.backups, { recursive: true });
  // 1. Keep the running version as a package file, and the database as an online-backup copy.
  const pack = npm(['pack', inst.pkgDir, '--pack-destination', versions, '--json'], versions);
  if (pack.status !== 0) throw new CliError(`Could not keep a copy of version ${inst.version}: ${pack.stderr.trim()}`, EXIT.error, 'nothing was changed');
  const previousPackage = path.join(versions, JSON.parse(pack.stdout)[0].filename);
  const dbBackup = path.join(sys.paths.backups, `${PRODUCT.bin}-pre-upgrade-${inst.version}-${Date.now()}.db`);
  await backup(sys.db.raw, dbBackup);
  const rec: UpgradeRecord = { from: inst.version, to: null, spec, fromSchema: schemaOf(sys.db), toSchema: null, previousPackage, dbBackup, eventsBefore: lastEvent(sys.db), eventsAfter: null, prefix: inst.prefix, layout: inst.layout, at: new Date().toISOString(), status: 'started' };
  records.push(rec);
  saveRecords(sys.home, records);

  // 2. Install the new version where this one is; it must start and pass doctor on this home (which applies its migrations).
  let problem: string | null = null;
  try {
    npmInstall(inst, specArg);
    const v = runInstalled(inst, sys.home, ['--version']);
    rec.to = v.stdout.trim();
    if (v.status !== 0 || !rec.to) throw new Error(`the new version does not start: ${v.stderr.trim().slice(0, 300)}`);
    const d = runInstalled(inst, sys.home, ['--json', 'doctor']);
    if (d.status !== 0) throw new Error(`the new version's doctor failed: ${(d.stdout + d.stderr).trim().slice(0, 300)}`);
  } catch (e: any) {
    problem = e.message;
  }

  const home = sys.home;
  const dbFile = sys.paths.db;
  const backupsDir = sys.paths.backups;
  if (problem) {
    // 3. Put everything back: the previous package, and the database copy if the new version migrated it.
    let detail = problem;
    try {
      npmInstall(inst, previousPackage);
    } catch (e: any) {
      detail += `; reinstalling ${inst.version} also failed (${e.message}); it is kept at ${previousPackage}`;
    }
    if (schemaOf(sys.db) > rec.fromSchema) {
      sys.close();
      const aside = restoreDatabase(dbFile, dbBackup, backupsDir);
      detail += `; database restored from before the upgrade (the migrated one is kept at ${aside})`;
    }
    rec.status = 'failed-restored';
    rec.detail = detail;
    saveRecords(home, records);
    const db = new Db(dbFile);
    emit(db, 'system.upgrade-failed', spec, { from: rec.from, detail });
    db.close();
    throw new CliError(`Upgrade to ${spec} failed and was undone: ${detail}`, EXIT.error);
  }

  // The new version may have migrated the database; read the facts from a fresh connection.
  const db = new Db(dbFile);
  rec.toSchema = schemaOf(db);
  emit(db, 'system.upgraded', rec.to, { from: rec.from, to: rec.to, fromSchema: rec.fromSchema, toSchema: rec.toSchema });
  rec.eventsAfter = lastEvent(db);
  db.close();
  rec.status = 'completed';
  saveRecords(home, records);
  ctx.out({ ok: true, ...rec }, () =>
    [`upgraded ${rec.from} -> ${rec.to} in ${inst.prefix}`, kv([['database', rec.toSchema === rec.fromSchema ? `schema ${rec.toSchema} (unchanged)` : `schema ${rec.fromSchema} -> ${rec.toSchema}`], ['previous version', previousPackage], ['database copy', dbBackup], ['undo', `${PRODUCT.bin} upgrade --rollback`]])].join('\n'),
  );
}

function rollbackUpgrade(ctx: Ctx, inst: Installation, records: UpgradeRecord[], discardNewer: boolean) {
  const sys = ctx.sys;
  const rec = [...records].reverse().find((r) => r.status === 'completed');
  if (!rec) throw new CliError('No completed upgrade to roll back', EXIT.notFound, `see the history with: ${PRODUCT.bin} upgrade --status`);
  if (!fs.existsSync(rec.previousPackage)) throw new CliError(`The kept copy of version ${rec.from} is missing: ${rec.previousPackage}`, EXIT.blocked);
  // Decide about the database before changing anything.
  const plan = rollbackDatabasePlan(rec, schemaOf(sys.db), lastEvent(sys.db), discardNewer);
  if (plan.action === 'refuse')
    throw new CliError(`${plan.newerEvents} change(s) were recorded after the upgrade, and the upgrade changed the database schema (${rec.fromSchema} -> ${rec.toSchema}); version ${rec.from} cannot read the current database and returning to the pre-upgrade copy would drop those changes. Nothing was changed.`, EXIT.blocked, `keep version ${rec.to}; or, to return anyway, repeat with --discard-newer-data (the current database is copied to backups first)`);
  if (plan.action === 'restore' && !fs.existsSync(rec.dbBackup)) throw new CliError(`The pre-upgrade database copy is missing: ${rec.dbBackup}`, EXIT.blocked, 'nothing was changed');

  npmInstall(inst, rec.previousPackage);
  const home = sys.home;
  const dbFile = sys.paths.db;
  const backupsDir = sys.paths.backups;
  let aside: string | null = null;
  if (plan.action === 'restore') {
    sys.close();
    aside = restoreDatabase(dbFile, rec.dbBackup, backupsDir);
  }
  const v = runInstalled(inst, home, ['--version']).stdout.trim();
  const d = runInstalled(inst, home, ['--json', 'doctor']);
  rec.status = 'rolled-back';
  rec.detail = plan.action === 'restore' ? `database restored from before the upgrade${plan.newerEvents ? ` (${plan.newerEvents} later change(s) discarded as asked)` : ''}; the replaced one is kept at ${aside}` : 'database kept (schema unchanged)';
  saveRecords(home, records);
  const db = new Db(dbFile);
  emit(db, 'system.rolled-back', rec.from, { from: rec.to, to: rec.from, database: plan.action, newerEvents: plan.newerEvents });
  db.close();
  ctx.out({ ok: v === rec.from && d.status === 0, version: v, doctor: d.status === 0 ? 'ok' : 'failed', database: plan.action, keptAt: aside }, () => [`returned to ${v} in ${inst.prefix}`, kv([['database', rec.detail], ['doctor', d.status === 0 ? 'all checks pass' : `failing: ${(d.stdout + d.stderr).trim().slice(0, 200)}`]])].join('\n'));
  if (v !== rec.from || d.status !== 0) process.exitCode = EXIT.error;
}
