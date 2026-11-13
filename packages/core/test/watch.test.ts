import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type EventRow, type Sys, emit, openSystem, watchEvents } from '../src/index';

const open: { sys: Sys; home: string; stop?: () => void }[] = [];
function sys(): Sys {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-watch-'));
  const s = openSystem(home);
  open.push({ sys: s, home });
  return s;
}
afterEach(() => {
  for (const o of open.splice(0)) {
    o.stop?.();
    o.sys.close();
    fs.rmSync(o.home, { recursive: true, force: true });
  }
});
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return ok();
};

describe('watchEvents', () => {
  it('delivers an event written in this process on the next turn, without waiting for the interval', async () => {
    const s = sys();
    emit(s.db, 'before.watch', 'x');
    const got: EventRow[] = [];
    open[0].stop = watchEvents(s.db, (rows) => got.push(...rows), { intervalMs: 0 }); // no polling at all
    emit(s.db, 'test.one', 'a');
    emit(s.db, 'test.two', 'b');
    expect(await until(() => got.length === 2, 500)).toBe(true);
    expect(got.map((e) => e.type)).toEqual(['test.one', 'test.two']); // in order, nothing from before the watch
  });

  it('never announces an event whose transaction rolled back', async () => {
    const s = sys();
    const got: string[] = [];
    open[0].stop = watchEvents(s.db, (rows) => got.push(...rows.map((e) => e.type)), { intervalMs: 0 });
    expect(() =>
      s.db.tx(() => {
        emit(s.db, 'test.rolled-back', 'x');
        throw new Error('abort');
      }),
    ).toThrow('abort');
    emit(s.db, 'test.kept', 'y');
    expect(await until(() => got.length > 0, 500)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(['test.kept']);
  });

  it('notices an event committed by another process', async () => {
    const s = sys();
    const got: EventRow[] = [];
    open[0].stop = watchEvents(s.db, (rows) => got.push(...rows), { intervalMs: 50 });
    const script = `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]); d.exec('PRAGMA busy_timeout=5000'); d.prepare("INSERT INTO events (ts, type, subject, origin) VALUES (?, 'test.other-process', 'x', 'cli')").run(new Date().toISOString()); d.close();`;
    execFileSync(process.execPath, ['-e', script, s.paths.db], { stdio: 'ignore' });
    expect(await until(() => got.some((e) => e.type === 'test.other-process'))).toBe(true);
    expect(got.find((e) => e.type === 'test.other-process')!.origin).toBe('cli');
  });

  it('stops delivering after it is stopped', async () => {
    const s = sys();
    const got: string[] = [];
    const stop = watchEvents(s.db, (rows) => got.push(...rows.map((e) => e.type)), { intervalMs: 20 });
    emit(s.db, 'test.seen', 'x');
    await until(() => got.length === 1, 500);
    stop();
    emit(s.db, 'test.unseen', 'x');
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toEqual(['test.seen']);
  });
});
