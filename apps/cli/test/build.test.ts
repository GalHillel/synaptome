import { type ChildProcess, execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT } from '@synaptome/core';
import { npmCliScript } from '../src/commands/upgrade';

// The built distribution, exercised the way a user runs it: a plain `node <launcher>`, no tsx, no repository env.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let out: string;
let homes: string[] = [];
const children: ChildProcess[] = [];

/** Environment without anything that points back into the repository. */
function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(SYNAPTOME|DRELQAVO|TSX|NODE_OPTIONS)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-dist-home-'));
  homes.push(h);
  return h;
}
const run = (args: string[], input?: string) => {
  const h = home();
  return spawnSync(process.execPath, [path.join(out, `${PRODUCT.bin}.mjs`), '--home', h, ...args], { encoding: 'utf8', input, cwd: os.tmpdir(), env: cleanEnv({ SYNAPTOME_CLAUDE_ROOT: path.join(h, 'no-claude') }) });
};

/** npm, run through the Node that runs the tests (no shell, no PATH lookup). */
const NPM_CLI = npmCliScript() ?? (() => { throw new Error('npm-cli.js not found for this Node'); })();
// Asynchronous: long synchronous waits (build, npm) keep the test worker from answering vitest and trip its RPC timeout.
const exec = (args: string[], cwd: string, env = cleanEnv()) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 << 20 }, (e: any, stdout, stderr) => resolve({ status: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr })));
const npm = (args: string[], cwd: string) => exec([NPM_CLI, ...args], cwd, cleanEnv({ npm_config_update_notifier: 'false' }));

beforeAll(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-dist-'));
  const r = await exec(['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.join(ROOT, 'scripts', 'build.ts'), out], ROOT, { ...process.env } as Record<string, string>);
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr || r.stdout}`);
}, 120_000);
afterAll(() => {
  for (const c of children) c.kill();
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

describe('built distribution', () => {
  it('contains only JavaScript, the web assets and a build record, with no TypeScript, no tsx and no repository path', () => {
    const files = fs.readdirSync(out, { recursive: true }).map(String).map((f) => f.replace(/\\/g, '/')).sort();
    expect(files).toEqual(['LICENSE', 'NOTICE', 'README.md', 'THIRD_PARTY_LICENSES.md', 'build-info.json', 'cli.mjs', 'package.json', `${PRODUCT.bin}.mjs`, 'web', 'web/app.css', 'web/app.js']);
    const cli = fs.readFileSync(path.join(out, 'cli.mjs'), 'utf8');
    expect(cli).not.toMatch(/from ["']tsx/);
    for (const p of [ROOT, ROOT.replace(/\\/g, '/'), ROOT.replace(/\\/g, '\\\\'), os.homedir()]) expect(cli.includes(p), `absolute path ${p} in the bundle`).toBe(false);
    const info = JSON.parse(fs.readFileSync(path.join(out, 'build-info.json'), 'utf8'));
    expect(info).toMatchObject({ name: PRODUCT.name, version: PRODUCT.version, node: '>=24' });
    expect(Object.keys(info.bundledPackages)).toEqual(expect.arrayContaining(['commander', 'ink', 'react']));
    expect(Object.keys(info.bundledPackages)).not.toContain('esbuild');
  });

  it('starts with plain node, prints its version without warnings, and works on a new home', () => {
    const v = run(['--version']);
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(PRODUCT.version);
    expect(v.stderr).toBe('');
    const s = run(['status', '--json']);
    expect(s.status, s.stderr).toBe(0);
    expect(JSON.parse(s.stdout)).toMatchObject({ capabilities: expect.anything() });
    expect(s.stderr).toBe('');
  });

  it('serves the prebuilt Command Center without esbuild', async () => {
    const h = home();
    const c = spawn(process.execPath, [path.join(out, `${PRODUCT.bin}.mjs`), '--home', h, '--json', 'dashboard', '--port', '0', '--no-open'], { cwd: os.tmpdir(), env: cleanEnv({ SYNAPTOME_CLAUDE_ROOT: path.join(h, 'no-claude') }) });
    children.push(c);
    const first = await new Promise<string>((resolve, reject) => {
      let buf = '';
      c.stdout!.on('data', (d) => ((buf += d), buf.includes('\n') && resolve(buf.split('\n')[0])));
      c.on('exit', (code) => reject(new Error(`dashboard exited ${code}`)));
      setTimeout(() => reject(new Error('dashboard did not start')), 20_000);
    });
    const { url } = JSON.parse(first);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Synaptome Command Center');
    const js = await fetch(new URL('/app.js', url));
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBe(fs.statSync(path.join(out, 'web', 'app.js')).size);
    c.kill();
  }, 30_000);

  it('answers an MCP initialize over stdio', () => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const r = run(['mcp'], `${msg}\n`);
    const reply = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === 1);
    expect(reply?.result?.serverInfo?.name).toBe(PRODUCT.mcpName);
  });

  it('packs into one dependency-free npm package with exactly the shipped files and no secrets, dev data or paths', async () => {
    const dest = home();
    const p = await npm(['pack', '--json', '--pack-destination', dest], out);
    expect(p.status, p.stderr).toBe(0);
    const [pack] = JSON.parse(p.stdout);
    expect(pack.files.map((f: any) => f.path.replace(/\\/g, '/')).sort()).toEqual(['LICENSE', 'NOTICE', 'README.md', 'THIRD_PARTY_LICENSES.md', 'build-info.json', 'cli.mjs', 'package.json', `${PRODUCT.bin}.mjs`, 'web/app.css', 'web/app.js']);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: PRODUCT.bin, version: PRODUCT.version, license: 'Apache-2.0', engines: { node: '>=24' }, bin: { [PRODUCT.bin]: `${PRODUCT.bin}.mjs` } });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.repository.url).toMatch(/^git\+https:\/\/github\.com\/[\w.-]+\/synaptome\.git$/);
    expect(manifest.bugs.url).toMatch(/\/synaptome\/issues$/);
    const secret = /(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,})/;
    for (const f of pack.files) {
      const text = fs.readFileSync(path.join(out, f.path), 'utf8');
      expect(secret.test(text), `secret-like string in ${f.path}`).toBe(false);
      for (const bad of ['.synaptome-dev', '.drelqavo-dev', 'docs/internal', ROOT, ROOT.replace(/\\/g, '/'), os.homedir()]) expect(text.includes(bad), `"${bad}" in ${f.path}`).toBe(false);
    }
    expect(pack.size).toBeLessThan(1_500_000); // packed size (gzip)
  }, 60_000);

  it('installs from the tarball into an empty prefix without the network and runs from there', async () => {
    const dest = home();
    const p = await npm(['pack', '--json', '--pack-destination', dest], out);
    const tarball = path.join(dest, JSON.parse(p.stdout)[0].filename);
    const prefix = home();
    const i = await npm(['install', '--prefix', prefix, tarball, '--offline', '--no-audit', '--no-fund'], prefix);
    expect(i.status, i.stderr).toBe(0);
    const shim = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? `${PRODUCT.bin}.cmd` : PRODUCT.bin);
    expect(fs.existsSync(shim)).toBe(true);
    const h = home();
    const v = spawnSync(`"${shim}" --home "${h}" status --json`, { shell: true, encoding: 'utf8', cwd: os.tmpdir(), env: cleanEnv({ SYNAPTOME_CLAUDE_ROOT: path.join(h, 'no-claude') }) });
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({ capabilities: expect.anything() });
    expect(fs.readdirSync(path.join(prefix, 'node_modules')).filter((d) => !d.startsWith('.'))).toEqual([PRODUCT.bin]); // nothing else pulled in
  }, 120_000);

  it('refuses to start on an older Node.js with a clear message', () => {
    const launcher = fs.readFileSync(path.join(out, `${PRODUCT.bin}.mjs`), 'utf8');
    // Run the launcher's version check with a pretend version (the real check runs before cli.mjs is loaded).
    const probe = path.join(out, 'old-node-probe.mjs');
    fs.writeFileSync(probe, `Object.defineProperty(process.versions, 'node', { value: '22.1.0' }); Object.defineProperty(process, 'version', { value: 'v22.1.0' });\n${launcher.replace(/^#!.*\n/, '')}`);
    const r = spawnSync(process.execPath, [probe, '--version'], { encoding: 'utf8', env: cleanEnv() });
    fs.rmSync(probe);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/needs Node\.js 24 or later; this is v22\.1\.0/);
    expect(r.stdout).toBe('');
  });
});
