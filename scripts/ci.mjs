#!/usr/bin/env node
/**
 * Release checks, in order; the first failure stops the run (exit 1). The same script runs locally (`npm run ci`) and
 * in `.github/workflows/ci.yml`, so a check never passes in one place and fails in the other.
 *
 *   node scripts/ci.mjs [--skip-audit]     (--skip-audit when there is no network)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// npm's script beside node.exe (Windows) or in <prefix>/lib/node_modules (Linux, macOS); else npm through the shell.
const npmCli = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((c) => fs.existsSync(c)) ?? '';
const npm = (...args) => (fs.existsSync(npmCli) ? [process.execPath, npmCli, ...args] : ['npm', ...args]);
const node = (...args) => [process.execPath, '--disable-warning=ExperimentalWarning', ...args];
const skipAudit = process.argv.includes('--skip-audit');

const steps = [
  ['Node.js 24 or later', () => Number(process.versions.node.split('.')[0]) >= 24 || `Node ${process.version}`],
  ['Typecheck', npm('run', 'typecheck')],
  // Includes the routing benchmark thresholds (packages/router/test/v2.test.ts), the build and pack tests, the
  // install/upgrade/uninstall tests in disposable homes, fuzzing and the concurrency stress test.
  ['Unit, integration, benchmark-threshold, fuzz and stress tests', npm('test')],
  ['Build (bundle, web assets, licence inventory; fails on a disallowed licence)', npm('run', 'build')],
  ['Built CLI starts and reports its version', node('dist/synaptome.mjs', '--version')],
  ...(skipAudit ? [] : [['Dependency vulnerabilities (npm audit, high and critical fail)', npm('audit', '--audit-level=high')]]),
];

let failed = null;
for (const [title, cmd] of steps) {
  const t0 = Date.now();
  process.stdout.write(`\n== ${title}\n`);
  let ok;
  let detail = '';
  if (typeof cmd === 'function') {
    const r = cmd();
    ok = r === true;
    detail = ok ? '' : String(r);
  } else {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit', shell: cmd[0] === 'npm' });
    ok = r.status === 0;
    detail = ok ? '' : `exit ${r.status}`;
  }
  process.stdout.write(`-- ${ok ? 'pass' : 'FAIL'} (${Math.round((Date.now() - t0) / 1000)} s)${detail ? `: ${detail}` : ''}\n`);
  if (!ok) {
    failed = title;
    break;
  }
}
process.stdout.write(failed ? `\nCI failed at: ${failed}\n` : `\nAll ${steps.length} checks passed.\n`);
process.exitCode = failed ? 1 : 0;
