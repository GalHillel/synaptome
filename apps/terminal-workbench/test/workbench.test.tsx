import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db, notify, tempSystem, upsertCapability, writeSnapshot } from '@synaptome/core';
import { type Api, createApi } from '@synaptome/service';
import { Workbench, clip, fitLine, pad, parseMouse, wrapLine } from '../src/index';
import { VIEWS } from '../src/model';

let sys: ReturnType<typeof tempSystem>;
let api: Api;
let claudeRoot: string;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function seed(name: string, status: 'approved' | 'registered', description: string, extra: Record<string, unknown> = {}) {
  const id = `acme.${name}`;
  const files = [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n# ${name}\nENTRY-BODY-${name}`, size: 1 }];
  upsertCapability(sys, { id, name, description, kind: 'skill', domain: 'docs', tags: ['docs'], entryFile: 'SKILL.md', license: { spdx: 'MIT', compatible: 'yes', evidence: 'test' }, provenance: { verified: true, method: 'test' }, security: { tier: 'A' }, quality: { total: 91 }, ...extra }, { status, ...writeSnapshot(sys, id, files), body: files[0].content });
}

beforeEach(() => {
  sys = tempSystem();
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
  fs.mkdirSync(path.join(claudeRoot, 'skills'));
  seed('release-notes', 'approved', 'Write release notes and changelog documentation from merged changes');
  seed('日本語-guide', 'registered', 'Wide-character name to exercise terminal width handling');
  seed('status-update', 'registered', 'Write internal status updates for leadership');
  api = createApi(sys, { claudeRoot, origin: 'tui' });
});
afterEach(() => {
  sys.dispose();
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe('text fitting', () => {
  it('measures wide characters and never exceeds the requested width', () => {
    expect(stringWidth(clip('日本語のテキスト', 7))).toBeLessThanOrEqual(7);
    expect(stringWidth(pad('日本', 10))).toBe(10);
    expect(pad('7', 4, true)).toBe('   7');
    expect(fitLine([{ t: 'abc' }, { t: 'defgh' }], 5).map((s) => s.t).join('')).toBe('abcd…');
    expect(fitLine([{ t: 'ab' }], 5).map((s) => s.t).join('')).toBe('ab   ');
    const wrapped = wrapLine([{ t: 'one two three four five six seven', c: 'mid' }], 12);
    expect(wrapped.length).toBeGreaterThan(2);
    for (const l of wrapped) expect(stringWidth(l.map((s) => s.t).join(''))).toBeLessThanOrEqual(12);
  });
});

describe('view models', () => {
  it('load real rows, inspector lines and contextual actions through the shared API', async () => {
    const skills = VIEWS.find((v) => v.id === 'skills')!;
    const rows = await skills.load(api, 'changelog');
    expect(rows.map((r) => r.id)).toEqual(['acme.release-notes']);
    const lines = (await skills.inspect(api, rows[0])).map((l) => l.map((s) => s.t).join('')).join('\n');
    expect(lines).toMatch(/release-notes/);
    expect(lines).toMatch(/PROMOTION GATE/);
    expect(skills.actions(rows[0], []).map((a) => a.label)).toEqual(['Install to sandbox host', 'Show entry file']);
    const pending = (await skills.load(api, 'status')).find((r) => r.id === 'acme.status-update')!;
    expect(skills.actions(pending, []).map((a) => a.label)).toEqual(expect.arrayContaining(['Approve', 'Reject']));
    for (const v of VIEWS) expect(Array.isArray(await v.load(api, ''))).toBe(true);
  });
});

describe('every view', () => {
  const frame = (r: ReturnType<typeof render>) => strip(r.lastFrame() ?? '');
  const goTo = async (r: ReturnType<typeof render>, title: string) => {
    r.stdin.write(':');
    await settle(130);
    r.stdin.write(title);
    await settle(130);
    r.stdin.write('\r');
    await settle(300);
  };

  it('has the six views added in Phase 9 alongside the original ten, each with a unique id', () => {
    const ids = VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['sources', 'notifications', 'integrations', 'agents', 'evals', 'start']));
    expect(ids.slice(0, 4)).toEqual(['overview', 'discover', 'skills', 'queue']); // keys 1-4 unchanged
  });

  it('opens on the view it is asked to start with (Get started on a first run)', async () => {
    const r = render(<Workbench api={api} size={{ columns: 120, rows: 30 }} pollMs={0} theme="dark" initialView="start" />);
    await settle(300);
    expect(frame(r)).toMatch(/Get started\s+\d+\/5/);
    expect(frame(r)).toContain('The system checks pass');
    r.unmount();
  });

  it('moves one view per key even when keys arrive faster than the screen redraws', async () => {
    const r = render(<Workbench api={api} size={{ columns: 120, rows: 30 }} pollMs={0} theme="dark" />);
    await settle();
    for (let i = 0; i < 3; i++) r.stdin.write('\t'); // no pause between keys
    await settle(300);
    expect(frame(r)).toMatch(/Queue\s+\d+\/\d+/);
    r.stdin.write('h');
    r.stdin.write('h');
    await settle(300);
    expect(frame(r)).toMatch(/Discover\s+\d+\/\d+/);
    r.unmount();
  });

  it('loads and inspects every view through the shared API', async () => {
    notify(sys, { level: 'action', kind: 'approval', title: 'Approval waiting for status-update', body: 'A capability passed every automatic gate.' });
    for (const v of VIEWS) {
      const rows = await v.load(api, '');
      const first = rows.find((x) => !x.section);
      if (first) expect((await v.inspect(api, first)).length, `${v.id} inspector`).toBeGreaterThan(0);
      expect(Array.isArray(v.actions(first ?? null, []))).toBe(true);
    }
  });

  // One test per width; views are stepped through with Tab and each is checked once its rows have loaded
  // (the list title shows "<n>/<m>" instead of "loading…"), so the test waits only as long as loading takes.
  for (const cols of [80, 120, 200]) {
    it(`draws every view within ${cols} columns`, async () => {
      const r = render(<Workbench api={api} size={{ columns: cols, rows: 30 }} pollMs={0} theme="dark" />);
      for (const [k, v] of VIEWS.entries()) {
        if (k) r.stdin.write('\t');
        const shown = new RegExp(`${v.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+/\\d+`);
        const end = Date.now() + 5000;
        while (!shown.test(frame(r)) && Date.now() < end) await settle(25);
        await settle(120); // an empty view reads "0/0" before and after loading; let its load and inspector finish
        const f = frame(r);
        expect(f, `${v.id} at ${cols}`).toMatch(shown);
        expect(f, `${v.id} at ${cols}`).not.toContain('Could not load');
        for (const l of f.split('\n')) expect(stringWidth(l), `${v.id} width at ${cols}`).toBeLessThanOrEqual(cols);
      }
      r.unmount();
    }, 60000);
  }

  it('Notifications: marks one read through the shared API', async () => {
    const id = notify(sys, { level: 'warning', kind: 'source', title: 'GitHub keeps failing', body: 'three failures in a row' })!;
    const v = VIEWS.find((x) => x.id === 'notifications')!;
    const rows = await v.load(api, 'github');
    expect(rows.map((x) => x.raw.id)).toEqual([id]);
    const a = v.actions(rows[0], []).find((x) => x.label === 'Mark read')!;
    await a.run(api, '');
    expect(sys.db.get<any>('SELECT read_at FROM notifications WHERE id=?', id).read_at).toBeTruthy();
    expect(v.actions((await v.load(api, 'github'))[0], []).map((x) => x.label)).toEqual(['Mark all read']);
  });

  it('Sources: switching a source off asks first and changes the shared state', async () => {
    const r = render(<Workbench api={api} size={{ columns: 140, rows: 30 }} pollMs={0} theme="dark" />);
    await settle();
    await goTo(r, 'Go to Sources');
    const first = (await VIEWS.find((x) => x.id === 'sources')!.load(api, ''))[0];
    expect(first.raw.enabled).toBe(true);
    r.stdin.write('a');
    await settle();
    expect(frame(r)).toContain('Switch off');
    r.stdin.write('\r');
    await settle();
    expect(frame(r)).toMatch(/Confirm: Switch off/i);
    expect(frame(r)).toContain('will not be scanned until switched on again');
    r.stdin.write('y');
    await settle(300);
    expect(frame(r)).toContain(`${first.raw.title} switched off`);
    expect((await api.call('sources.list')).find((s: any) => s.id === first.id), frame(r)).toMatchObject({ enabled: false });
    r.unmount();
  });

  it('Integrations lists providers and host adapters; Agents lists the five specialists', async () => {
    const integ = await VIEWS.find((x) => x.id === 'integrations')!.load(api, '');
    expect(integ.filter((x) => x.section).map((x) => (x.cells[0] as any).t)).toEqual([expect.stringMatching(/^Model providers/), expect.stringMatching(/^Host adapters/)]);
    expect(integ.some((x) => x.id === 'host:claude-code')).toBe(true);
    const prov = integ.find((x) => x.raw?.type === 'provider')!;
    expect(VIEWS.find((x) => x.id === 'integrations')!.actions(prov, [])[0].confirm!.length).toBeGreaterThan(0); // a live call is never made without asking
    const agents = await VIEWS.find((x) => x.id === 'agents')!.load(api, '');
    expect(agents.map((x) => x.id)).toEqual(['researcher', 'architect', 'implementer', 'reviewer', 'tester']);
  });

  it('Network: expands a domain, lists a capability\'s links and jumps along one', async () => {
    sys.db.run("INSERT INTO relations (src, rel, dst, weight, evidence, created_at) VALUES ('acme.release-notes', 'complements', 'acme.status-update', 2, 'test', ?)", new Date().toISOString());
    const v = VIEWS.find((x) => x.id === 'network')!;
    expect((await v.load(api, '')).map((x) => x.id)).toEqual(['d:docs']); // collapsed tree
    expect((await v.load(api, 'status')).map((x) => x.id)).toEqual(['d:docs', 'c:acme.status-update']); // a filter opens matching domains

    const r = render(<Workbench api={api} size={{ columns: 140, rows: 30 }} pollMs={0} theme="dark" />);
    await settle();
    await goTo(r, 'Go to Network');
    expect(frame(r)).toMatch(/docs\s+3 capabilities/);
    r.stdin.write('\r'); // actions for the domain row
    await settle();
    r.stdin.write('\r'); // expand
    await settle(300);
    expect(frame(r)).toContain('release-notes');
    r.stdin.write('j'); // the most linked capability comes first
    await settle(250);
    expect(frame(r)).toMatch(/LINKS 1[\s\S]*complements[\s\S]*status-update/);
    r.stdin.write('a');
    await settle();
    expect(frame(r)).toContain('Go to status-update');
    r.stdin.write('\r');
    // Wait until the jump has landed and the inspector shows the linked capability (time varies under a busy run).
    for (const end = Date.now() + 5000; !/INSPECTOR[\s\S]*acme\.status-update/.test(frame(r)) && Date.now() < end; ) await settle(50);
    expect(frame(r)).toContain('at status-update');
    expect(frame(r)).toMatch(/INSPECTOR[\s\S]*acme\.status-update/); // the selection moved to the linked capability
    r.unmount();
  });

  it('Get started counts existing skills as indexed only once the inventory has run (registered capabilities are not enough)', async () => {
    const v = VIEWS.find((x) => x.id === 'start')!;
    const step = async () => (await v.load(api, '')).find((r) => r.id === 'inventory')!.raw;
    expect(await step()).toMatchObject({ done: false, detail: expect.stringMatching(/has not looked/) });
    await api.call('inventory.run');
    expect(await step()).toMatchObject({ done: true, detail: expect.stringMatching(/indexed and audited/) });
  });

  it('Get started reflects real state and its step actions open the right view', async () => {
    const r = render(<Workbench api={api} size={{ columns: 140, rows: 30 }} pollMs={0} theme="dark" />);
    await settle();
    await goTo(r, 'Go to Get started');
    expect(frame(r)).toContain('A model provider is verified');
    expect(frame(r)).toMatch(/to do/);
    for (let i = 0; i < 3; i++) (r.stdin.write('j'), await settle(60)); // step 4: provider
    await settle(200);
    expect(frame(r)).toMatch(/Next[\s\S]*Open Integrations/i);
    r.stdin.write('a');
    await settle();
    r.stdin.write('\r');
    await settle(300);
    expect(frame(r)).toContain('Model providers');
    expect(frame(r)).toMatch(/Host adapters/);
    r.unmount();
  });
});

describe('help, themes and mouse', () => {
  const frame = (r: ReturnType<typeof render>) => strip(r.lastFrame() ?? '');
  /** Screen position (1-based, as a terminal reports it) of the first cell of `text`. */
  const at = (r: ReturnType<typeof render>, text: string, maxX = Infinity) => {
    const lines = frame(r).split('\n');
    const y = lines.findIndex((l) => l.includes(text) && stringWidth(l.slice(0, l.indexOf(text))) < maxX);
    expect(y, `"${text}" on screen`).toBeGreaterThanOrEqual(0);
    return { x: stringWidth(lines[y].slice(0, lines[y].indexOf(text))) + 1, y: y + 1 };
  };
  const LIST = 80; // in a 140-column frame the list pane ends before column 80, the inspector starts after it
  const click = (p: { x: number; y: number }, button = 0) => `\x1b[<${button};${p.x};${p.y}M\x1b[<${button};${p.x};${p.y}m`;

  it('parses SGR mouse reports and leaves ordinary keys alone', () => {
    expect(parseMouse('[<0;12;5M')).toEqual([{ button: 0, x: 11, y: 4, press: true }]);
    expect(parseMouse('\x1b[<65;3;9M\x1b[<65;3;9M')).toHaveLength(2);
    expect(parseMouse('[<0;1;1m')![0].press).toBe(false);
    for (const k of ['j', '[', '<', 'abc', '']) expect(parseMouse(k)).toBeNull();
  });

  it('selects with a click, opens with a second click, switches views from the list and scrolls with the wheel', async () => {
    const r = render(<Workbench api={api} size={{ columns: 140, rows: 28 }} pollMs={0} theme="dark" mouse />);
    await settle();
    r.stdin.write(click(at(r, '3 Skills')));
    await settle(250);
    expect(frame(r)).toMatch(/Skills\s+1\/3/);
    r.stdin.write(click(at(r, 'status-update', LIST)));
    await settle(250);
    expect(frame(r)).toMatch(/INSPECTOR[\s\S]*acme\.status-update/);
    r.stdin.write(click(at(r, 'status-update', LIST)));
    await settle(200);
    expect(frame(r)).toContain('Actions for'); // second click = Enter: the actions menu
    r.stdin.write('\x1b');
    await settle();
    r.stdin.write(click(at(r, 'release-notes', LIST), 65)); // wheel down over the list
    await settle(200);
    expect(frame(r)).toMatch(/Skills\s+3\/3/);
    r.unmount();
  });

  it('never types a mouse report into a text field, with or without mouse mode', async () => {
    for (const mouse of [false, true]) {
      const r = render(<Workbench api={api} size={{ columns: 120, rows: 24 }} pollMs={0} theme="dark" mouse={mouse} />);
      await settle();
      r.stdin.write('3');
      await settle();
      r.stdin.write('/');
      await settle(130);
      r.stdin.write('\x1b[<0;30;8M');
      await settle(130);
      expect(frame(r)).not.toMatch(/\/\S*\[</);
      expect(frame(r)).toContain('release-notes'); // the filter is still empty
      r.unmount();
    }
  });

  it('reports readiness once and every frame through callbacks that may return anything', async () => {
    let ready = 0;
    let last: string[] = [];
    const r = render(<Workbench api={api} size={{ columns: 100, rows: 24 }} pollMs={0} theme="dark" onReady={() => void ready++} onFrame={(l) => (last = l) as any} />);
    await settle(200);
    r.stdin.write('3');
    await settle(200);
    r.stdin.write('1');
    await settle(200);
    expect(ready).toBe(1);
    expect(last).toHaveLength(24);
    expect(Math.max(...last.map((l) => stringWidth(l)))).toBeLessThanOrEqual(100);
    r.unmount();
  });

  it('saves the theme chosen with t as the shared ui.theme setting', async () => {
    const r = render(<Workbench api={api} size={{ columns: 120, rows: 24 }} pollMs={0} theme="dark" />);
    await settle();
    r.stdin.write('t');
    await settle(200);
    expect(frame(r)).toContain('theme light');
    expect((await api.call('system.settings')).ui.theme).toBe('light');
    expect(sys.db.get<any>("SELECT origin FROM events WHERE type='settings.changed' ORDER BY id DESC LIMIT 1").origin).toBe('tui');
    r.unmount();
  });

  it('help explains the current view and lists what can be done with the selected item', async () => {
    const r = render(<Workbench api={api} size={{ columns: 120, rows: 24 }} pollMs={0} theme="dark" mouse />);
    await settle();
    r.stdin.write('3');
    await settle(200);
    r.stdin.write('?');
    await settle();
    const f = frame(r);
    expect(f).toContain('The registry: every capability');
    expect(f).toMatch(/on the selected item: Install to sandbox host/);
    for (let i = 0; i < 30; i++) r.stdin.write('j');
    await settle();
    expect(frame(r)).toContain('Shift+drag selects text'); // mouse help, reached by scrolling
    r.stdin.write('\x1b');
    await settle();
    expect(frame(r)).not.toContain('Help   j/k scroll');
    r.unmount();
  });
});

describe('workbench', () => {
  const frame = (r: ReturnType<typeof render>) => strip(r.lastFrame() ?? '');
  const open = (columns: number, rows = 28) => render(<Workbench api={api} size={{ columns, rows }} pollMs={0} theme="dark" />);

  it('shows an event written by another process without a key press, and reloads the view', async () => {
    const r = render(<Workbench api={api} size={{ columns: 140, rows: 28 }} pollMs={40} theme="dark" />);
    await settle();
    expect(frame(r)).toContain('no new events');
    // Another writer (a second connection, which SQLite treats like another process) records an event.
    const other = new Db(sys.paths.db);
    other.run("INSERT INTO events (ts, type, subject, origin) VALUES (?, 'scan.finished', 'github', 'cli')", new Date().toISOString());
    other.close();
    const end = Date.now() + 3000;
    while (!frame(r).includes('scan.finished github via cli') && Date.now() < end) await settle(30);
    expect(frame(r)).toContain('scan.finished github via cli');
    r.unmount();
  });

  it('uses three panes when wide, hides the inspector when medium, and collapses to one pane when narrow', async () => {
    for (const [cols, nav, insp] of [[140, true, true], [96, true, false], [60, false, false]] as const) {
      const r = open(cols);
      await settle();
      const f = frame(r);
      const lines = f.split('\n');
      expect(lines.length).toBeLessThanOrEqual(28);
      for (const l of lines) expect(stringWidth(l), `width at ${cols}`).toBeLessThanOrEqual(cols);
      expect(f.includes(' VIEWS')).toBe(nav);
      expect(f.includes('INSPECTOR')).toBe(insp);
      expect(f).toContain('Overview');
      r.unmount();
    }
  });

  it('navigates by keyboard, filters, and shows details', async () => {
    const r = open(140);
    await settle();
    r.stdin.write('3'); // Skills
    await settle();
    expect(frame(r)).toContain('release-notes');
    expect(frame(r)).toContain('日本語-guide');
    r.stdin.write('/');
    await settle(130);
    r.stdin.write('changelog');
    await settle(200);
    expect(frame(r)).toContain('/changelog');
    expect(frame(r)).not.toContain('status-update');
    r.stdin.write('\r');
    await settle(200);
    expect(frame(r)).toMatch(/PROMOTION GATE|QUALITY/); // inspector filled for the selected row
    r.stdin.write('\x1b'); // Esc clears the filter
    await settle(200);
    expect(frame(r)).toContain('status-update');
    r.unmount();
  });

  it('opens the inspector as its own pane on a narrow terminal', async () => {
    const r = open(60, 24);
    await settle();
    r.stdin.write('3');
    await settle();
    r.stdin.write('\r');
    await settle(200);
    expect(frame(r)).toContain('Inspector');
    expect(frame(r)).toMatch(/acme\./);
    r.stdin.write('\x1b');
    await settle();
    expect(frame(r)).not.toContain('Inspector   Esc back');
    r.unmount();
  });

  it('runs a real action from the actions menu and the shared state changes', async () => {
    const r = open(140);
    await settle();
    r.stdin.write('3');
    await settle();
    r.stdin.write('/');
    await settle(130);
    r.stdin.write('changelog');
    await settle(130);
    r.stdin.write('\r');
    await settle(200);
    r.stdin.write('a');
    await settle();
    expect(frame(r)).toContain('Install to sandbox host');
    r.stdin.write('\r');
    await settle(400);
    expect(frame(r)).toMatch(/staged at/);
    const inst = sys.db.get<any>("SELECT * FROM installations WHERE capability_id='acme.release-notes'");
    expect(inst).toMatchObject({ scope: 'sandbox', status: 'installed' });
    expect(sys.db.get<any>("SELECT origin FROM events WHERE type='install.completed'").origin).toBe('tui');
    r.unmount();
  });

  it('asks for confirmation with consequences before a rejection and can be cancelled', async () => {
    const r = open(140);
    await settle();
    r.stdin.write('4'); // Queue
    await settle(200);
    expect(frame(r)).toMatch(/Pending approval/);
    r.stdin.write('a');
    await settle();
    r.stdin.write('j'); // Reject
    r.stdin.write('\r');
    await settle();
    expect(frame(r)).toContain('Reason');
    r.stdin.write('not needed');
    await settle(130);
    r.stdin.write('\r');
    await settle();
    expect(frame(r)).toMatch(/confirm: reject/i);
    r.stdin.write('n');
    await settle();
    expect(sys.db.get<{ n: number }>("SELECT COUNT(*) n FROM capabilities WHERE status='rejected'")!.n).toBe(0);
    r.unmount();
  });

  it('offers a searchable command palette, a help overlay and theme switching', async () => {
    const r = open(120);
    await settle();
    r.stdin.write(':');
    await settle(130);
    r.stdin.write('logs');
    await settle();
    expect(frame(r)).toContain('Go to Logs');
    r.stdin.write('\r');
    await settle(200);
    expect(frame(r)).toMatch(/EVENT/);
    r.stdin.write('?');
    await settle();
    expect(frame(r)).toContain('command palette');
    r.stdin.write('\x1b');
    await settle(130);
    r.stdin.write('t');
    await settle();
    expect(frame(r)).toContain('theme light');
    r.unmount();
  });

  it('shows a usable message instead of crashing when a view fails to load', async () => {
    const broken = { ...api, call: async (name: string, args?: unknown) => (name === 'capabilities.list' ? Promise.reject(new Error('disk on fire')) : api.call(name, args)) } as Api;
    const r = render(<Workbench api={broken} size={{ columns: 100, rows: 24 }} pollMs={0} />);
    await settle();
    r.stdin.write('3');
    await settle(200);
    expect(frame(r)).toContain('Could not load Skills: disk on fire');
    expect(frame(r)).toContain('Press r to try again');
    r.stdin.write('1');
    await settle(200);
    expect(frame(r)).toContain('Capabilities');
    r.unmount();
  });
});
