import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

// Builds the package once for the whole black-box run (or uses SYNAPTOME_DIST, e.g. an unpacked published tarball),
// and hands its folder to the tests. The tests then only run `node <dist>/synaptome.mjs …`.
const ROOT = path.resolve(import.meta.dirname, '..', '..');

declare module 'vitest' {
  export interface ProvidedContext {
    dist: string;
  }
}

export default function setup(project: TestProject) {
  let dist = process.env.SYNAPTOME_DIST;
  let built: string | null = null;
  if (!dist) {
    built = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-bb-dist-'));
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.join(ROOT, 'scripts', 'build.ts'), built], { cwd: ROOT, stdio: 'pipe' });
    dist = built;
  }
  if (!fs.existsSync(path.join(dist, 'synaptome.mjs'))) throw new Error(`no synaptome.mjs in ${dist}`);
  project.provide('dist', dist);
  return () => {
    if (built) fs.rmSync(built, { recursive: true, force: true });
  };
}
