import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, inject } from 'vitest';

/**
 * Black-box harness. Rules for every test in this folder (see README.md):
 * - run only the built package (`synaptome.mjs` from the build), never import product source;
 * - expectations come from the documented behaviour and the plan, not from reading the implementation;
 * - every home, project and Claude root is a disposable folder; the user's real ones are never touched.
 */
const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

export function tempDir(label: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `synaptome-bb-${label}-`));
  made.push(d);
  return d;
}

/** A clean environment: none of the product's variables leak in from the developer's shell. */
export function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null && !/^(SYNAPTOME_|DRELQAVO_|TSX)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export interface Run { code: number; out: string; err: string; json: any }

/** Runs the built CLI against a given home. */
export function syn(home: string, args: string[], opts: { input?: string; env?: Record<string, string>; cwd?: string; claudeRoot?: string } = {}): Run {
  const bin = path.join(inject('dist'), 'synaptome.mjs');
  const env = cleanEnv({ SYNAPTOME_CLAUDE_ROOT: opts.claudeRoot ?? path.join(home, 'no-claude'), ...(opts.env ?? {}) });
  const r = spawnSync(process.execPath, [bin, '--home', home, ...args], { encoding: 'utf8', input: opts.input, env, cwd: opts.cwd ?? os.tmpdir(), maxBuffer: 64 << 20, timeout: 120_000 });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '', json };
}

/** A disposable Claude Code root holding the given skills (SKILL.md with name and description only). */
export function fakeClaudeRoot(skills: { name: string; description: string; body?: string }[]) {
  const root = tempDir('claude');
  for (const s of skills) {
    const dir = path.join(root, 'skills', s.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\nlicense: MIT\n---\n\n# ${s.name}\n\n${s.body ?? s.description}\n`);
  }
  return root;
}

export const read = (f: string) => fs.readFileSync(f, 'utf8');
export const readJson = (f: string) => JSON.parse(read(f));
export const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};
