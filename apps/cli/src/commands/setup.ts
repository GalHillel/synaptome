import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { PRODUCT, type Sys, emit, pathsFor } from '@synaptome/core';
import { checkInstallations, listInstallations, restoreMissingInstall, rollback } from '@synaptome/acquisition';
import { createApi, runDiagnostics } from '@synaptome/service';
import { snapshotProvider } from '@synaptome/core';
import { CliError, type Ctx, EXIT, action, kv } from '../ctx';
import { depsFor } from './acquisition';
import { bridgeInit, bridgeRemove, bridgedProjects, launcherPath } from './routing';

/**
 * Installation lifecycle on this machine (Phase 10): `init` sets up and verifies, `repair` finds and fixes what drifted,
 * `uninstall --everything` removes what Synaptome created. None of them changes a host or a project the user did not
 * name, and data is deleted only when asked by name.
 */

const INSTALL_RECORD = 'install.json';
export const installRecordPath = (sys: Sys) => path.join(sys.home, INSTALL_RECORD);

function writeInstallRecord(sys: Sys, extra: Record<string, unknown> = {}) {
  const file = installRecordPath(sys);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const rec = { product: PRODUCT.name, version: PRODUCT.version, initialisedAt: prev.initialisedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), launcher: launcherPath(), platform: `${process.platform}-${process.arch}`, node: process.versions.node, ...extra };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

/** What Synaptome promises before it is used; printed by init. */
export const PERMISSIONS = [
  'Discovery reads public sources within each source\'s terms and daily budget; downloads go to quarantine and are never executed.',
  'Nothing is installed into an AI host unless you run install; installs go to a sandbox copy first, and a real install needs --real --yes.',
  'Global Claude Code configuration is never changed. Connecting a project writes only into that project (bridge init / init --project).',
  'Task text is sent to a model provider only by commands that say so (forge, evaluations, agent teams), and only to providers the privacy setting allows.',
  'Credentials are read from the environment when a call is made and never stored.',
  'Everything Synaptome stores is in its home folder; uninstall --everything removes what it created elsewhere.',
];

export function registerSetup(program: Command) {
  program
    .command('init')
    .description('set up Synaptome on this machine: system check, storage, hosts (read only), optional project connection, verification')
    .option('--project <dir>', "connect this project's Claude Code to Synaptome (writes only into that project)")
    .option('--no-hook', 'with --project: no prompt hook, only the MCP server and the bridge skill')
    .option('--inventory', 'index and audit the skills already installed for Claude Code (read only)')
    .action(
      action(async (ctx, opts: { project?: string; hook: boolean; inventory?: boolean }) => {
        const sys = ctx.sys;
        const api = createApi(sys, { origin: 'cli' });
        const firstTime = !fs.existsSync(installRecordPath(sys));
        const major = Number(process.versions.node.split('.')[0]);
        const system = { os: `${os.type()} ${os.release()}`, platform: `${process.platform}-${process.arch}`, node: process.versions.node, nodeOk: major >= 24, shell: process.env.ComSpec && !process.env.PSModulePath ? 'cmd' : process.env.PSModulePath ? 'PowerShell' : (process.env.SHELL ?? 'unknown'), windowsTerminal: !!process.env.WT_SESSION };
        const schema = sys.db.get<{ v: number }>('SELECT MAX(version) v FROM schema_migrations')!.v;
        const hosts = (await api.call('system.adapters')) as any[];
        const inventory = opts.inventory ? await api.call('inventory.run') : null;
        const project = opts.project ? bridgeInit(sys, opts.project, { hook: opts.hook }) : null;
        const checks = runDiagnostics(sys);
        const failing = checks.filter((c) => c.status === 'fail');
        const record = writeInstallRecord(sys);
        emit(sys.db, 'system.initialised', PRODUCT.version, { firstTime, project: project?.dir ?? null, inventory: !!inventory });
        const next = [
          `${PRODUCT.bin}                 open the Terminal Workbench (its Get started view lists the next steps)`,
          `${PRODUCT.bin} dashboard       open the Web Command Center`,
          ...(project ? [] : [`${PRODUCT.bin} init --project <folder>   connect one project's Claude Code`]),
          ...(inventory ? [] : [`${PRODUCT.bin} inventory       index the skills already on this machine (read only)`]),
        ];
        const result = { ok: !failing.length && system.nodeOk, firstTime, home: sys.home, schema, system, hosts: hosts.map((h) => ({ id: h.id, title: h.title, status: h.status, detected: !!h.detected?.present })), permissions: PERMISSIONS, inventory: inventory ? { indexed: inventory.indexed, flagged: inventory.flagged.length } : null, project, checks, record, next };
        ctx.out(result, () =>
          [
            `${PRODUCT.name} ${PRODUCT.version} ${firstTime ? 'set up' : 'checked'} in ${sys.home}`,
            '',
            'SYSTEM',
            kv([['os', `${system.os} (${system.platform})`], ['node', `${system.node} ${system.nodeOk ? '(ok)' : '(needs 24 or later)'}`], ['shell', `${system.shell}${system.windowsTerminal ? ' in Windows Terminal' : ''}`]]),
            '',
            'STORAGE',
            kv([['home', sys.home], ['database', `schema version ${schema}`], ['state', firstTime ? 'created' : 'already set up; nothing was reset']]),
            '',
            'HOSTS (detected only; nothing is changed)',
            ...hosts.filter((h) => h.status !== 'UNSUPPORTED').map((h) => `  ${h.detected?.present ? 'found    ' : 'not found'}  ${h.title} (${String(h.status).toLowerCase().replace(/_/g, ' ')})`),
            '',
            'WHAT SYNAPTOME WILL AND WILL NOT DO',
            ...PERMISSIONS.map((p) => `  - ${p}`),
            ...(inventory ? ['', 'EXISTING SKILLS', `  ${inventory.indexed} indexed, ${inventory.flagged.length} flagged by the audit`] : []),
            ...(project ? ['', 'PROJECT', `  connected ${project.dir}${project.hook ? ' (MCP server, bridge skill, prompt hook)' : ' (MCP server, bridge skill)'}`, `  undo: ${PRODUCT.bin} bridge remove "${project.dir}"`] : []),
            '',
            'VERIFICATION',
            `  ${checks.length - failing.length} of ${checks.length} checks pass${failing.length ? `; failing: ${failing.map((f) => `${f.label} (${f.detail})`).join('; ')}` : ''}`,
            '',
            'NEXT',
            ...next.map((n) => `  ${n}`),
          ].join('\n'),
        );
        if (!result.ok) process.exitCode = EXIT.error;
      }),
    );

  program
    .command('repair')
    .description('check the home folder, database, stored snapshots, installed files and connected projects; --fix applies the safe fixes')
    .option('--fix', 'apply the safe fixes (recreate folders, put back deleted installs from their stored version, reconnect projects whose files went missing)')
    .action(action(async (ctx, opts: { fix?: boolean }) => repair(ctx, !!opts.fix)));
}

interface Finding { area: string; item: string; problem: string; fix: string | null; fixed: boolean }

async function repair(ctx: Ctx, fix: boolean) {
  const sys = ctx.sys;
  const deps = depsFor(sys);
  const found: Finding[] = [];
  const add = (f: Omit<Finding, 'fixed'>, apply?: () => void) => {
    let fixed = false;
    if (fix && apply) {
      try {
        apply();
        fixed = true;
      } catch (e: any) {
        f = { ...f, problem: `${f.problem}; fix failed: ${e.message}` };
      }
    }
    found.push({ ...f, fixed });
  };

  // 1. Home folder layout.
  const p = pathsFor(sys.home);
  for (const [name, dir] of Object.entries(p).filter(([k]) => !['home', 'db'].includes(k))) if (!fs.existsSync(dir)) add({ area: 'home', item: name, problem: `${dir} is missing`, fix: 'recreate the empty folder' }, () => fs.mkdirSync(dir, { recursive: true }));
  if (!fs.existsSync(installRecordPath(sys))) add({ area: 'home', item: INSTALL_RECORD, problem: 'no installation record (init never ran here, or it was deleted)', fix: 'write it' }, () => writeInstallRecord(sys));

  // 2. Database: an integrity failure is reported, never "fixed" by rewriting data.
  const integrity = sys.db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check;
  if (integrity !== 'ok') {
    const backups = fs.existsSync(p.backups) ? fs.readdirSync(p.backups).filter((f) => f.endsWith('.db')).sort() : [];
    add({ area: 'database', item: PRODUCT.dbFile, problem: `integrity check: ${integrity}`, fix: null });
    if (backups.length) found[found.length - 1].problem += `; latest backup: ${path.join(p.backups, backups[backups.length - 1])}`;
  }

  // 3. Stored snapshots: each one is re-hashed against its recorded content hash.
  const snaps = sys.db.all<{ id: string; snapshot_path: string }>('SELECT id, snapshot_path FROM capabilities WHERE snapshot_path IS NOT NULL');
  const store = snapshotProvider(sys);
  for (const s of snaps) {
    let problem: string | null = null;
    try {
      if (!store.read(s.id)) problem = 'stored copy is missing';
    } catch (e: any) {
      problem = e.message;
    }
    if (problem) add({ area: 'snapshot', item: s.id, problem, fix: null });
  }

  // 4. Installed files against the fingerprint taken at install time.
  for (const c of checkInstallations(sys, deps)) {
    if (c.state === 'ok') continue;
    add({ area: 'install', item: `${c.id} ${c.capabilityId} (${c.scope})`, problem: `${c.target}: ${c.detail}`, fix: c.state === 'missing' ? 'put it back from the stored version' : null }, c.state === 'missing' ? () => void restoreMissingInstall(sys, deps, c.id) : undefined);
  }

  // 5. Connected projects: record gone, files gone, or pointing at a launcher that no longer exists.
  for (const b of bridgedProjects(sys)) {
    if (!b.present) {
      add({ area: 'project', item: b.dir, problem: 'the bridge record is gone from the project (removed by hand?)', fix: 'forget the project' }, () => void emit(sys.db, 'bridge.removed', b.dir, { by: 'repair' }));
      continue;
    }
    const m = JSON.parse(fs.readFileSync(path.join(b.dir, PRODUCT.bridgeFile), 'utf8'));
    const mcp = fs.existsSync(m.mcpPath) ? JSON.parse(fs.readFileSync(m.mcpPath, 'utf8')) : null;
    const problems = [
      !fs.existsSync(m.skillPath) && 'bridge skill missing',
      !mcp?.mcpServers?.[PRODUCT.mcpName] && 'MCP server entry missing',
      b.launcher && !fs.existsSync(b.launcher) && `launcher ${b.launcher} no longer exists`,
      b.launcher && path.resolve(b.launcher) !== path.resolve(launcherPath()) && fs.existsSync(launcherPath()) && `points at another installation (${b.launcher})`,
    ].filter(Boolean) as string[];
    if (problems.length) add({ area: 'project', item: b.dir, problem: problems.join('; '), fix: 'reconnect it to this installation (remove exactly what was added, add it again)' }, () => {
      bridgeRemove(sys, b.dir);
      bridgeInit(sys, b.dir, { hook: !!m.hook });
    });
  }

  const open = found.filter((f) => !f.fixed);
  ctx.out({ ok: !open.length, checked: { snapshots: snaps.length, installations: listInstallations(sys, { managedOnly: true, status: 'installed', limit: 10_000 }).length, projects: bridgedProjects(sys).length }, findings: found }, () =>
    found.length
      ? [
          ...found.map((f) => `${f.fixed ? 'fixed  ' : f.fix ? 'fixable' : 'manual '}  ${f.area.padEnd(8)} ${f.item}\n           ${f.problem}${f.fixed ? '' : f.fix ? `\n           fix: ${f.fix} (run: ${PRODUCT.bin} repair --fix)` : ''}`),
          '',
          open.length ? `${open.length} problem(s) left${open.some((f) => !f.fix) ? '; the ones marked manual need a decision (see above)' : ''}` : 'everything that was found is fixed',
        ].join('\n')
      : `nothing to repair: home folder, database, ${snaps.length} snapshot(s), installed files and connected projects all check out`,
  );
  if (open.length) process.exitCode = EXIT.error;
}

/**
 * Everything Synaptome created outside its home folder, undone: every live managed installation is rolled back
 * (newest first, so each puts back exactly what it replaced) and every connected project is disconnected. Without
 * --yes it only lists what it would do. The home folder (registry, history, backups) is kept unless --delete-data
 * is given too. Edited installs are left in place unless --force (then the edits are copied to the backups first,
 * which --delete-data would remove, so the two are refused together).
 */
export async function uninstallEverything(ctx: Ctx, opts: { yes?: boolean; deleteData?: boolean; force?: boolean }) {
  const sys = ctx.sys;
  const deps = depsFor(sys);
  if (opts.deleteData && opts.force) throw new CliError('--force keeps copies of edited files in the home folder, which --delete-data would delete', EXIT.usage, 'run uninstall --everything --force --yes first, move the copies you want, then --delete-data');
  const installs = listInstallations(sys, { managedOnly: true, status: 'installed', limit: 10_000 });
  const projects = bridgedProjects(sys).filter((b) => b.present);
  const home = sys.home;
  const plan = {
    installs: installs.map((i) => ({ id: i.id, capabilityId: i.capabilityId, scope: i.scope, target: i.targetPath })),
    projects: projects.map((b) => b.dir),
    deleteData: !!opts.deleteData,
    home,
  };
  if (!opts.yes) {
    ctx.out({ ok: true, dryRun: true, plan }, () =>
      [
        'Nothing was changed. With --yes this would:',
        `  roll back ${installs.length} installation(s)${installs.some((i) => i.scope === 'real') ? `, ${installs.filter((i) => i.scope === 'real').length} of them in real host folders` : ''}`,
        ...installs.map((i) => `    ${i.id}  ${i.capabilityId}  (${i.scope})  ${i.targetPath}`),
        `  disconnect ${projects.length} project(s)`,
        ...projects.map((b) => `    ${b.dir}`),
        opts.deleteData ? `  then DELETE the home folder ${home} (registry, history, backups)` : `  keep the home folder ${home} (add --delete-data to delete it)`,
        '',
        `Then remove the program itself with: npm uninstall -g ${PRODUCT.bin}`,
      ].join('\n'),
    );
    return;
  }

  const done: { installs: { id: string; result: string }[]; projects: { dir: string; result: string }[]; dataDeleted: boolean } = { installs: [], projects: [], dataDeleted: false };
  // Newest first; a rollback can bring back an older installation, which the loop then rolls back too.
  for (let guard = 0; guard < 10_000; guard++) {
    const next = listInstallations(sys, { managedOnly: true, status: 'installed', limit: 10_000 }).find((i) => !done.installs.some((d) => d.id === i.id && d.result !== 'rolled back'));
    if (!next) break;
    try {
      const r = rollback(sys, deps, next.id, { force: !!opts.force });
      done.installs.push({ id: next.id, result: `rolled back${r.preserved ? `; edited files copied to ${r.preserved}` : ''}` });
    } catch (e: any) {
      done.installs.push({ id: next.id, result: `kept: ${e.message}` });
    }
  }
  for (const b of projects) {
    try {
      bridgeRemove(sys, b.dir);
      done.projects.push({ dir: b.dir, result: 'disconnected' });
    } catch (e: any) {
      done.projects.push({ dir: b.dir, result: `kept: ${e.message}` });
    }
  }
  const kept = [...done.installs, ...done.projects].filter((x) => x.result.startsWith('kept'));
  emit(sys.db, 'system.uninstalled', PRODUCT.version, { installs: done.installs.length, projects: done.projects.length, kept: kept.length, deleteData: !!opts.deleteData });
  if (opts.deleteData) {
    if (kept.length) throw new CliError(`${kept.length} item(s) could not be undone, so the home folder (which records them) was kept`, EXIT.blocked, 'resolve them (see above) and run again');
    // Only a folder that is a Synaptome home, and never a drive root or the user's own home folder.
    const resolved = path.resolve(home);
    if (!fs.existsSync(path.join(resolved, PRODUCT.dbFile)) || resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) throw new CliError(`${resolved} does not look like a ${PRODUCT.name} home folder; not deleting it`, EXIT.blocked);
    sys.close();
    fs.rmSync(resolved, { recursive: true, force: true });
    done.dataDeleted = true;
  }
  ctx.out({ ok: !kept.length, ...done, home }, () =>
    [
      ...done.installs.map((d) => `${d.result.startsWith('kept') ? 'kept   ' : 'removed'}  installation ${d.id}: ${d.result}`),
      ...done.projects.map((d) => `${d.result.startsWith('kept') ? 'kept   ' : 'removed'}  project ${d.dir}: ${d.result}`),
      done.dataDeleted ? `deleted  ${home}` : `kept     ${home} (your registry and history; delete it with --delete-data)`,
      '',
      `Remove the program itself with: npm uninstall -g ${PRODUCT.bin}`,
    ].join('\n'),
  );
  if (kept.length) process.exitCode = EXIT.blocked;
}
