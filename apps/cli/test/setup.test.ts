import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSystem, upsertCapability, writeSnapshot } from '@synaptome/core';

// init, repair and uninstall --everything through the real CLI, against a disposable home, a sandbox host and a temp project.
// Each test starts several CLI processes (up to eight); on a fresh checkout under a full parallel run each one takes
// seconds, which the default 20 s limit did not allow for (observed in a clean copy of the public tree).
vi.setConfig({ testTimeout: 90_000 });
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'synaptome.mjs');
let root: string;
let home: string;
let project: string;

/** One CLI run in its own process. Asynchronous, so a test with many runs never blocks the test worker for long. */
function cli(...args: string[]): Promise<{ code: number; json: any; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(process.execPath, [BIN, '--home', home, '--json', ...args], { encoding: 'utf8', maxBuffer: 32 << 20, env: { ...process.env, SYNAPTOME_CLAUDE_ROOT: path.join(root, 'no-claude') } }, (e: any, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* not JSON */
      }
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, json, out: stdout, err: stderr });
    }),
  );
}
const tree = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);
const installed = async () => (await cli('installs')).json.installations.find((i: any) => i.status === 'installed');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-setup-'));
  home = path.join(root, 'home'); // does not exist yet: init creates it
  project = path.join(root, 'project');
  fs.mkdirSync(project);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedApproved() {
  const sys = openSystem(home);
  const files = [{ path: 'SKILL.md', content: '---\nname: internal-comms\ndescription: Write internal communications such as status reports\n---\n# Internal comms\nBODY', size: 1 }];
  upsertCapability(sys, { id: 'acme.internal-comms', name: 'internal-comms', description: 'Write internal communications such as status reports', kind: 'skill', domain: 'docs', tags: ['status'], entryFile: 'SKILL.md' }, { status: 'approved', ...writeSnapshot(sys, 'acme.internal-comms', files), body: files[0].content });
  sys.close();
}

describe('init', () => {
  it('creates the home, reports system, hosts and promises, verifies, and is safe to run again', async () => {
    const first = await cli('init');
    expect(first.code, first.err).toBe(0);
    expect(first.json).toMatchObject({ ok: true, firstTime: true, home, system: { nodeOk: true } });
    expect(first.json.hosts.map((h: any) => h.id)).toContain('claude-code');
    expect(first.json.permissions.join(' ')).toMatch(/Global Claude Code configuration is never changed/);
    expect(first.json.checks.every((c: any) => c.status !== 'fail')).toBe(true);
    expect(fs.existsSync(path.join(home, 'install.json'))).toBe(true);
    expect(tree(project)).toEqual([]); // no project named, none touched
    seedApproved();
    const again = await cli('init');
    expect(again.json).toMatchObject({ ok: true, firstTime: false });
    expect((await cli('status')).json.capabilities.total).toBe(1); // nothing was reset
  });

  it('connects only the project it is given, and records it', async () => {
    const r = await cli('init', '--project', project);
    expect(r.code, r.err).toBe(0);
    expect(r.json.project).toMatchObject({ dir: project });
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(true);
    expect((await cli('events', '--type', 'bridge.initialised')).out).toContain(project.replace(/\\/g, '\\\\'));
  });
});

describe('repair', () => {
  it('reports nothing on a healthy home, then finds and fixes a deleted install, a deleted installation record and a broken project link', async () => {
    seedApproved();
    expect((await cli('init', '--project', project)).code).toBe(0);
    expect((await cli('install', 'acme.internal-comms')).code).toBe(0);
    const healthy = await cli('repair');
    expect(healthy.code, healthy.out).toBe(0);
    expect(healthy.json.findings).toEqual([]);

    const inst = await installed();
    fs.rmSync(inst.targetPath, { recursive: true });
    fs.rmSync(path.join(home, 'install.json')); // (deleted folders are recreated by any command that opens the home)
    fs.rmSync(path.join(project, '.claude', 'skills', 'synaptome'), { recursive: true });

    const found = await cli('repair');
    expect(found.code).toBe(1);
    expect(found.json.findings.map((f: any) => f.area).sort()).toEqual(['home', 'install', 'project']);
    expect(found.json.findings.every((f: any) => f.fix && !f.fixed)).toBe(true);
    expect(fs.existsSync(inst.targetPath)).toBe(false); // report only

    const fixed = await cli('repair', '--fix');
    expect(fixed.code, fixed.out).toBe(0);
    expect(fixed.json.findings.every((f: any) => f.fixed)).toBe(true);
    expect(fs.readFileSync(path.join(inst.targetPath, 'SKILL.md'), 'utf8')).toContain('BODY');
    expect(fs.existsSync(path.join(home, 'install.json'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'synaptome', 'SKILL.md'))).toBe(true);
    expect((await cli('repair')).json.findings).toEqual([]);
  });

  it('never overwrites an installed file that was edited, and never rewrites a damaged snapshot', async () => {
    seedApproved();
    expect((await cli('install', 'acme.internal-comms')).code).toBe(0);
    const inst = await installed();
    fs.appendFileSync(path.join(inst.targetPath, 'SKILL.md'), '\nmy own note');
    const snap = openSystem(home);
    const snapDir = snap.db.get<{ p: string }>("SELECT snapshot_path p FROM capabilities WHERE id='acme.internal-comms'")!.p;
    snap.close();
    fs.appendFileSync(path.join(snapDir, 'SKILL.md'), 'tampered');
    const r = await cli('repair', '--fix');
    expect(r.code).toBe(1);
    expect(r.json.findings.map((f: any) => [f.area, f.fix, f.fixed])).toEqual(expect.arrayContaining([['install', null, false], ['snapshot', null, false]]));
    expect(fs.readFileSync(path.join(inst.targetPath, 'SKILL.md'), 'utf8')).toContain('my own note');
  });
});

describe('uninstall --everything', () => {
  it('lists without --yes, then rolls back installs and disconnects projects, keeping the data unless asked', async () => {
    seedApproved();
    fs.writeFileSync(path.join(project, 'mine.txt'), 'user file');
    expect((await cli('init', '--project', project)).code).toBe(0);
    expect((await cli('install', 'acme.internal-comms')).code).toBe(0);
    const target = (await installed()).targetPath;

    const dry = await cli('uninstall', '--everything');
    expect(dry.json).toMatchObject({ dryRun: true, plan: { projects: [project], deleteData: false } });
    expect(dry.json.plan.installs).toHaveLength(1);
    expect(fs.existsSync(target)).toBe(true);

    const r = await cli('uninstall', '--everything', '--yes');
    expect(r.code, r.out).toBe(0);
    expect(r.json.installs[0].result).toBe('rolled back');
    expect(fs.existsSync(target)).toBe(false);
    expect(tree(project)).toEqual(['mine.txt']); // exactly the user's own file is left
    expect(fs.existsSync(path.join(home, 'synaptome.db'))).toBe(true);

    const gone = await cli('uninstall', '--everything', '--yes', '--delete-data');
    expect(gone.code, gone.out).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('keeps an edited install (and then the data) unless forced, and refuses --force with --delete-data', async () => {
    seedApproved();
    expect((await cli('install', 'acme.internal-comms')).code).toBe(0);
    const target = (await installed()).targetPath;
    fs.appendFileSync(path.join(target, 'SKILL.md'), '\nedited');
    const r = await cli('uninstall', '--everything', '--yes', '--delete-data');
    expect(r.code).toBe(3);
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(home)).toBe(true);
    expect((await cli('uninstall', '--everything', '--yes', '--delete-data', '--force')).code).toBe(2);
    expect((await cli('uninstall')).code).toBe(2); // neither an id nor --everything
  });
});
