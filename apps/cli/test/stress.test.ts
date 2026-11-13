import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EventRow, openSystem, upsertCapability, watchEvents, writeSnapshot } from '@synaptome/core';

// Concurrency stress (Phase 11, T-16): several processes write to one home at the same time, as the CLI, the
// terminal workbench, the dashboard and the MCP server do, while this process watches the event log live.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const WORKERS = 6;
const ROUNDS = 40;
let root: string;
let home: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-stress-'));
  home = path.join(root, 'home');
  const sys = openSystem(home);
  const files = [{ path: 'SKILL.md', content: '---\nname: shared\ndescription: A capability every worker installs and rolls back\n---\n# Shared\nBODY', size: 1 }];
  upsertCapability(sys, { id: 'acme.shared', name: 'shared', description: 'A capability every worker installs and rolls back', kind: 'skill', domain: 'docs', tags: [], entryFile: 'SKILL.md' }, { status: 'approved', ...writeSnapshot(sys, 'acme.shared', files), body: files[0].content });
  sys.close();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const worker = (n: number) =>
  new Promise<{ who: string; installs: number; errors: string[] }>((resolve, reject) =>
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.join(HERE, 'fixtures', 'stress-worker.ts'), home, String(n), String(ROUNDS), path.join(root, 'no-claude')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20 }, (e, stdout, stderr) => {
      if (e) return reject(new Error(`worker ${n} failed: ${stderr || e.message}`));
      resolve(JSON.parse(stdout.trim().split('\n').pop()!));
    }),
  );

describe('concurrent writers', () => {
  it(`${WORKERS} processes writing at once: no error but lost races, nothing lost, nothing corrupted, the live watcher sees every event once`, async () => {
    const sys = openSystem(home);
    const startId = sys.db.get<{ m: number }>('SELECT COALESCE(MAX(id),0) m FROM events')!.m;
    const seen: number[] = [];
    const stop = watchEvents(sys.db, (rows: EventRow[]) => seen.push(...rows.map((r) => r.id)), { intervalMs: 50 });

    const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
    // Let the watcher catch up with everything committed. A fixed pause was not enough under a full parallel run
    // (timers fire late under load), so wait for the count with a deadline; the assertions below are unchanged.
    const total = () => sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM events WHERE id > ?', startId)!.n;
    for (const until = Date.now() + 10_000; seen.length < total() && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 150)); // one more interval: a duplicate delivery would show up here
    stop();

    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(results.reduce((n, r) => n + r.installs, 0)).toBeGreaterThan(0);
    // Nothing lost: every tick of every worker is in the log, once.
    expect(sys.db.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE type = 'stress.tick'")!.n).toBe(WORKERS * ROUNDS);
    // Nothing corrupted: the database checks out, and the host holds at most one live installation of the capability.
    expect(sys.db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check).toBe('ok');
    expect(sys.db.get<{ n: number }>("SELECT COUNT(*) n FROM installations WHERE capability_id = 'acme.shared' AND status = 'installed'")!.n).toBeLessThanOrEqual(1);
    // The live watcher (another process's view) saw every committed event exactly once, in order.
    const committed = sys.db.all<{ id: number }>('SELECT id FROM events WHERE id > ? ORDER BY id', startId).map((r) => r.id);
    expect(seen).toEqual(committed);
    sys.close();
  }, 180_000);
});
