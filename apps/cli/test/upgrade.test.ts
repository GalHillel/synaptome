import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, PRODUCT, openSystem } from '@synaptome/core';
import { rollbackDatabasePlan } from '../src/commands/upgrade';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const NEXT = '0.2.99';

describe('rollback database rule', () => {
  it('keeps the database when the schema did not change, restores it only when nothing happened since, and otherwise refuses unless told', () => {
    expect(rollbackDatabasePlan({ fromSchema: 8, eventsAfter: 100 }, 8, 150, false)).toEqual({ action: 'keep', newerEvents: 50 });
    expect(rollbackDatabasePlan({ fromSchema: 8, eventsAfter: 100 }, 9, 100, false)).toEqual({ action: 'restore', newerEvents: 0 });
    expect(rollbackDatabasePlan({ fromSchema: 8, eventsAfter: 100 }, 9, 103, false)).toEqual({ action: 'refuse', newerEvents: 3 });
    expect(rollbackDatabasePlan({ fromSchema: 8, eventsAfter: 100 }, 9, 103, true)).toEqual({ action: 'restore', newerEvents: 3 });
  });

  it('an older version refuses to open a database written by a newer one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-newer-'));
    openSystem(home).close();
    const db = new Db(path.join(home, PRODUCT.dbFile));
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'from the future', '2030-01-01')");
    db.close();
    expect(() => openSystem(home)).toThrow(/schema version 999, written by a newer Synaptome/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// Two real versions of the package, installed into a throw-away prefix exactly as npm would.
describe('upgrade and rollback of an installed copy', () => {
  let work: string;
  let tarballs: { current: string; next: string; broken: string };
  let prefix: string;
  let home: string;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(SYNAPTOME|DRELQAVO|TSX|NODE_OPTIONS)/.test(k)) env[k] = v;
  const launcher = () => path.join(prefix, 'node_modules', PRODUCT.bin, `${PRODUCT.bin}.mjs`);
  // Asynchronous, so the test worker stays responsive while npm installs run (long synchronous waits trip vitest's RPC timeout).
  const exec = (args: string[], opts: { cwd: string; env: Record<string, string> }) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, args, { ...opts, encoding: 'utf8', maxBuffer: 32 << 20 }, (e: any, stdout, stderr) => resolve({ status: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr })));
  const run = async (...args: string[]) => {
    const r = await exec([launcher(), '--home', home, ...args], { cwd: os.tmpdir(), env: { ...env, SYNAPTOME_CLAUDE_ROOT: path.join(work, 'no-claude') } });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };
  const pack = async (dir: string) => path.join(work, JSON.parse((await exec([NPM_CLI, 'pack', dir, '--json', '--pack-destination', work], { cwd: work, env: { ...env, npm_config_update_notifier: 'false' } })).stdout)[0].filename);

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-upgrade-'));
    const dist = path.join(work, 'dist');
    const b = await exec(['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.join(ROOT, 'scripts', 'build.ts'), dist], { cwd: ROOT, env });
    if (b.status !== 0) throw new Error(b.stderr);
    // The "next" version: the same build with another version number (in the product identity and the manifest).
    const derive = (name: string, version: string, patch?: (cli: string) => string) => {
      const d = path.join(work, name);
      fs.cpSync(dist, d, { recursive: true });
      let cli = fs.readFileSync(path.join(d, 'cli.mjs'), 'utf8');
      const before = cli;
      cli = cli.replace(new RegExp(`(bin: "${PRODUCT.bin}",\\s*version: )"${PRODUCT.version.replace(/\./g, '\\.')}"`), `$1"${version}"`);
      if (cli === before) throw new Error('version not found in the bundle');
      fs.writeFileSync(path.join(d, 'cli.mjs'), patch ? patch(cli) : cli);
      const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2));
      return d;
    };
    tarballs = {
      current: await pack(dist),
      next: await pack(derive('next', NEXT)),
      // A version that installs but cannot start: the upgrade must undo itself.
      broken: await pack(derive('broken', '0.2.98', (cli) => `throw new Error('broken build');\n${cli}`)),
    };
    prefix = path.join(work, 'prefix');
    fs.mkdirSync(prefix);
    home = path.join(work, 'home');
    const i = await exec([NPM_CLI, 'install', '--prefix', prefix, tarballs.current, '--offline', '--no-audit', '--no-fund'], { cwd: prefix, env: { ...env, npm_config_update_notifier: 'false' } });
    if (i.status !== 0) throw new Error(i.stderr);
  }, 180_000);
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  it('a source checkout is told that upgrade applies to installed copies', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'cli', 'bin', 'synaptome.mjs'), '--home', path.join(work, 'src-home'), '--json', 'upgrade', 'x'], { encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/source checkout/);
  });

  it('upgrades in place, keeping the previous version and a database copy, then rolls back keeping the data', async () => {
    expect((await run('init')).code).toBe(0);
    expect((await run('config', 'set', 'ui.theme', 'dark')).code).toBe(0); // some data that must survive both ways
    const up = await run('--json', 'upgrade', tarballs.next);
    expect(up.code, up.out + up.err).toBe(0);
    expect(up.json).toMatchObject({ ok: true, from: PRODUCT.version, to: NEXT, status: 'completed' });
    expect(fs.existsSync(up.json.previousPackage)).toBe(true);
    expect(fs.existsSync(up.json.dbBackup)).toBe(true);
    expect((await run('--version')).out).toBe(NEXT);
    expect((await run('--json', 'doctor')).code).toBe(0);

    expect((await run('config', 'set', 'ui.theme', 'light')).code).toBe(0); // changed after the upgrade
    const back = await run('--json', 'upgrade', '--rollback');
    expect(back.code, back.out + back.err).toBe(0);
    expect(back.json).toMatchObject({ ok: true, version: PRODUCT.version, database: 'keep' });
    expect((await run('--version')).out).toBe(PRODUCT.version);
    expect((await run('--json', 'config', 'get', 'ui.theme')).out).toContain('light'); // nothing written after the upgrade was lost
    expect((await run('--json', 'upgrade', '--status')).json.records.map((r: any) => r.status)).toEqual(['rolled-back']);
  }, 180_000);

  it('a new version that does not start is removed again and the previous one put back', async () => {
    const r = await run('--json', 'upgrade', tarballs.broken);
    expect(r.code).toBe(1);
    expect(r.json.error.message).toMatch(/failed and was undone: the new version does not start/);
    expect((await run('--version')).out).toBe(PRODUCT.version);
    expect((await run('--json', 'doctor')).code).toBe(0);
    expect((await run('--json', 'upgrade', '--status')).json.records.at(-1)).toMatchObject({ status: 'failed-restored', from: PRODUCT.version });
  }, 180_000);
});