/**
 * Terminal Workbench entry point. The screen lives in `workbench.tsx`, views in `views/` (assembled by
 * `model.ts`), width-safe text helpers in `text.ts`, colours in `theme.ts`.
 */
import fs from 'node:fs';
import { render } from 'ink';
import stringWidth from 'string-width';
import { PRODUCT, env, openSystem } from '@synaptome/core';
import { createApi } from '@synaptome/service';
import { GLYPH } from './kit';
import { Workbench } from './workbench';

export { Workbench, type WorkbenchProps, parseMouse } from './workbench';
export { clip, fitLine, pad, wrapLine } from './text';

/* ---------- entry point ---------- */

/** Button presses and the wheel only (1000), reported in SGR form (1006) so columns beyond 223 work. No motion tracking. */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/**
 * Startup report (diagnostics and the terminal matrix, `scripts/tui-matrix.ps1`): with SYNAPTOME_TUI_REPORT=<file>
 * the workbench writes what it saw (terminal size, glyph set, time from process start to the first painted frame and to
 * the first frame with data, the widest line it drew) and, at exit, that it restored the terminal. With
 * SYNAPTOME_TUI_EXIT_AFTER_MS it then quits by itself through the normal quit path. Nothing is sent anywhere.
 */
function startupReport() {
  const file = env('TUI_REPORT');
  const exitAfter = Number(env('TUI_EXIT_AFTER_MS') ?? 0);
  const r: Record<string, any> = { pid: process.pid, node: process.versions.node, startMs: Math.round(performance.now()) };
  const save = () => {
    if (file) fs.writeFileSync(file, JSON.stringify(r, null, 2));
  };
  return { on: !!file, exitAfter, r, save };
}

export async function runWorkbench(opts: { home?: string; theme?: string; mouse?: boolean } = {}): Promise<void> {
  const rep = startupReport();
  const sys = openSystem(opts.home);
  const api = createApi(sys, { origin: 'tui' });
  const { theme: saved, mouse: savedMouse, onboarded } = sys.settings().ui;
  // First run (no interface has been opened on this home yet): open Get started, once.
  if (!onboarded) await api.call('settings.set', { key: 'ui.onboarded', value: true });
  const mouse = opts.mouse ?? savedMouse;
  const out = process.stdout;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (mouse) out.write(MOUSE_OFF);
    out.write('\x1b[?1049l\x1b[?25h'); // leave the alternate screen, show the cursor
    try {
      sys.close();
    } catch {
      /* already closed */
    }
    if (rep.on) (rep.r.restoredMs = Math.round(performance.now())), rep.save();
  };
  out.write('\x1b[?1049h\x1b[H'); // alternate screen: the user's scrollback is left untouched
  if (mouse) out.write(MOUSE_ON);
  await new Promise<void>((resolve) => {
    let last: string[] = [];
    const onReady = () => {
      if (!rep.on) return;
      Object.assign(rep.r, {
        readyMs: Math.round(performance.now()), readyAt: Date.now(),
        terminal: { columns: out.columns, rows: out.rows, isTTY: !!out.isTTY, windowsTerminal: !!process.env.WT_SESSION, unicodeGlyphs: GLYPH.sel !== '>' },
      });
      // The frame on screen when the first view's data arrived (rendered on the next tick).
      setTimeout(() => {
        Object.assign(rep.r, { frame: last, frameRows: last.length, widestLine: Math.max(0, ...last.map((l) => stringWidth(l))) });
        rep.save();
        if (rep.exitAfter) setTimeout(() => app.unmount(), rep.exitAfter);
      }, 50);
    };
    const app = render(<Workbench api={api} theme={opts.theme ?? saved} mouse={mouse} initialView={onboarded ? undefined : 'start'} onQuit={() => app.unmount()} onReady={onReady} onFrame={rep.on ? (l) => (last = l) : undefined} />, { exitOnCtrlC: false });
    if (rep.on) rep.r.firstPaintMs = Math.round(performance.now());
    const fail = (e: unknown) => {
      if (rep.on) rep.r.error = String((e as Error)?.stack ?? e);
      app.unmount();
      restore();
      process.stderr.write(`${PRODUCT.name} workbench stopped after an error: ${(e as Error)?.message ?? e}\nYour terminal has been restored. Non-interactive commands still work, e.g. synaptome status\n`);
      process.exitCode = 1;
      resolve();
    };
    process.once('uncaughtException', fail);
    process.once('unhandledRejection', fail);
    app.waitUntilExit().then(
      () => {
        process.off('uncaughtException', fail);
        process.off('unhandledRejection', fail);
        restore();
        resolve();
      },
      fail,
    );
  });
}
