/**
 * Performance at registry sizes (Phase 11 S4). For each size it builds a disposable home: the 70 labelled routing
 * benchmark capabilities (real text) plus synthetic ones up to the size (varied names, domains, tags and descriptions,
 * like a large discovered registry), then measures what a person waits for. Results go to `.tmp/perf/perf.json`.
 *
 *   npx tsx scripts/perf.ts [sizes=1000,10000,50000] [launcher=dist/synaptome.mjs]
 *
 * In-process numbers (queries, routing, events) exclude Node start-up; the CLI and dashboard numbers include it and
 * use the built launcher, as a user runs it. Times are wall clock on this machine.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_TASKS, seedBenchmark } from '@synaptome/router';
import { type EventRow, emit, openSystem, upsertCapability, watchEvents } from '@synaptome/core';
import { createApi } from '@synaptome/service';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sizes = (process.argv[2] ?? '1000,10000,50000').split(',').map(Number);
const launcher = path.resolve(root, process.argv[3] ?? 'dist/synaptome.mjs');
const outDir = path.join(root, '.tmp', 'perf');
fs.mkdirSync(outDir, { recursive: true });

const DOMAINS = ['docs', 'testing', 'devops', 'security', 'data', 'frontend', 'backend', 'design', 'research', 'ml', 'mobile', 'cloud', 'database', 'writing', 'finance', 'legal'];
const WORDS = ['release', 'notes', 'changelog', 'docker', 'kubernetes', 'terraform', 'react', 'hooks', 'testing', 'playwright', 'pytest', 'postgres', 'migration', 'index', 'query', 'cache', 'redis', 'oauth', 'jwt', 'webhook', 'stripe', 'invoice', 'pdf', 'excel', 'chart', 'report', 'audit', 'threat', 'model', 'review', 'refactor', 'lint', 'format', 'schema', 'api', 'graphql', 'grpc', 'queue', 'kafka', 'spark', 'notebook', 'pandas', 'figma', 'tokens', 'accessibility', 'i18n', 'seo', 'copy', 'email', 'status', 'update', 'leadership', 'incident', 'runbook', 'on-call', 'metrics', 'tracing', 'logging', 'alerts', 'budget', 'forecast', 'contract', 'privacy'];
function prng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const ms = (n: number) => Math.round(n * 10) / 10;
async function timeAll<T>(n: number, fn: (i: number) => Promise<T> | T) {
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    await fn(i);
    t.push(performance.now() - a);
  }
  return { p50: ms(pct(t, 50)), p95: ms(pct(t, 95)), max: ms(Math.max(...t)) };
}
const exec = (args: string[]) => new Promise<number>((resolve) => {
  const a = performance.now();
  execFile(process.execPath, args, { cwd: os.tmpdir(), maxBuffer: 64 << 20 }, () => resolve(performance.now() - a));
});

const results: any[] = [];
for (const size of sizes) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `synaptome-perf-${size}-`));
  const claudeRoot = path.join(home, 'no-claude');
  const r = prng(size);
  const t0 = performance.now();
  const sys = openSystem(home);
  const real = seedBenchmark(sys);
  for (let i = real; i < size; i++) {
    const w = Array.from({ length: 2 + Math.floor(r() * 2) }, () => pick(r, WORDS));
    const name = `${w.join('-')}-${i}`;
    upsertCapability(sys, { id: `perf.${name}`, name, description: `${w.join(' ')}: ${Array.from({ length: 10 }, () => pick(r, WORDS)).join(' ')} for ${pick(r, DOMAINS)} work`, kind: 'skill', domain: pick(r, DOMAINS), tags: w, entryFile: 'SKILL.md', quality: { total: 50 + Math.floor(r() * 50) }, security: { tier: 'A', trust: 'REVIEWED_COMMUNITY' } }, { status: r() < 0.5 ? 'approved' : 'registered' });
  }
  const seedMs = performance.now() - t0;
  const dbBytes = fs.statSync(path.join(home, 'synaptome.db')).size;
  const api = createApi(sys, { claudeRoot, origin: 'perf' });
  const res: any = { size, seedSeconds: Math.round(seedMs / 100) / 10, databaseMB: Math.round(dbBytes / 1e5) / 10 };

  // Queries the interfaces make.
  res.overview = await timeAll(20, () => api.call('system.overview'));
  res.listFirstPage = await timeAll(30, () => api.call('capabilities.list', { limit: 200 }));
  res.search = await timeAll(50, (i) => api.call('capabilities.list', { q: pick(prng(i), WORDS), limit: 200 }));
  res.graph = await timeAll(5, () => api.call('graph.get'));
  // Routing, over the labelled benchmark tasks.
  res.route = await timeAll(60, (i) => api.call('routing.route', { task: BENCH_TASKS[i % BENCH_TASKS.length].task }));
  res.rssMB = Math.round(process.memoryUsage().rss / 1e6);

  // Events: 2,000 written in a burst, delivered by a watcher on a second connection (as another process sees them).
  const other = openSystem(home);
  let got = 0;
  const start = sys.db.get<{ m: number }>('SELECT MAX(id) m FROM events')!.m;
  const done = new Promise<number>((resolve) => {
    const a = performance.now();
    const stop = watchEvents(other.db, (rows: EventRow[]) => {
      got += rows.filter((e) => e.type === 'perf.tick').length;
      if (got >= 2000) (stop(), resolve(performance.now() - a));
    }, { after: start, intervalMs: 50 });
  });
  for (let i = 0; i < 2000; i++) emit(sys.db, 'perf.tick', 'perf', { i });
  res.events2000DeliveredMs = ms(await done);
  other.close();

  // A sandbox install of one real benchmark capability (snapshot, materialise, verify, fingerprint).
  res.sandboxInstall = await timeAll(5, async () => {
    const inst = await api.call('capabilities.install', { id: 'b.unit-test-writing' }).catch(() => null);
    if (inst) await api.call('installations.rollback', { id: inst.id });
  });
  sys.close();

  // As a user runs it: the built CLI and the dashboard, cold.
  if (fs.existsSync(launcher)) {
    const cli: number[] = [];
    for (let i = 0; i < 5; i++) cli.push(await exec([launcher, '--home', home, '--json', 'status']));
    res.cliStatusColdMs = { p50: ms(pct(cli, 50)), max: ms(Math.max(...cli)) };
    const route: number[] = [];
    for (let i = 0; i < 5; i++) route.push(await exec([launcher, '--home', home, '--json', 'route', BENCH_TASKS[i].task]));
    res.cliRouteColdMs = { p50: ms(pct(route, 50)), max: ms(Math.max(...route)) };
    res.dashboardReadyMs = await new Promise<number>((resolve) => {
      const a = performance.now();
      const c = spawn(process.execPath, [launcher, '--home', home, '--json', 'dashboard', '--port', '0', '--no-open']);
      c.stdout.once('data', async (d) => {
        const url = JSON.parse(String(d).split('\n')[0]).url;
        await fetch(url).then((x) => x.text());
        resolve(ms(performance.now() - a));
        c.kill();
      });
    });
  }
  results.push(res);
  process.stdout.write(JSON.stringify(res) + '\n');
  fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, `home-${size}.txt`), home); // kept for the terminal measurements; delete when done
}
