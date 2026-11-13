import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { PRODUCT, openSystem, setOrigin } from '@synaptome/core';
import { startServer } from '@synaptome/service';
import { EXIT } from '../ctx';

export function registerUi(program: Command) {
  program
    .command('dashboard')
    .description('start the Web Command Center on this machine (loopback only)')
    .option('-p, --port <port>', 'port to listen on', '4319')
    .option('--no-open', 'do not open a browser window')
    .action(async (opts: { port: string; open: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals();
      setOrigin('web');
      const sys = openSystem(g.home);
      const { buildWebAssets } = await import('@synaptome/command-center/build');
      let server;
      try {
        server = await startServer(sys, { port: Number(opts.port), assets: buildWebAssets });
      } catch (e: any) {
        sys.close();
        const inUse = e?.code === 'EADDRINUSE';
        const msg = inUse ? `Port ${opts.port} is already in use` : e?.message ?? String(e);
        if (g.json) process.stdout.write(JSON.stringify({ ok: false, error: { message: msg } }) + '\n');
        else process.stderr.write(`error: ${msg}\n${inUse ? '  hint: another dashboard may be running; use --port <n> for a second one\n' : ''}`);
        process.exitCode = inUse ? EXIT.unavailable : EXIT.error;
        return;
      }
      if (g.json) process.stdout.write(JSON.stringify({ ok: true, url: server.url, port: server.port, home: sys.home }) + '\n');
      else process.stdout.write(`${PRODUCT.name} Command Center\n  ${server.url}\n  home ${sys.home}\n  loopback only; press Ctrl+C to stop\n`);
      if (opts.open && !g.json && process.stdout.isTTY) {
        const [bin, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', server.url]] : process.platform === 'darwin' ? ['open', [server.url]] : ['xdg-open', [server.url]];
        spawn(bin, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
      }
      const stop = async () => {
        await server.close();
        sys.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });

  program
    .command('tui', { isDefault: true })
    .description('open the Terminal Workbench (also what plain `synaptome` does)')
    .option('--theme <theme>', 'dark | light | auto')
    .option('--mouse', 'click to select, wheel to scroll (Shift+drag still selects text in most terminals)')
    .option('--no-mouse', 'keyboard only, even if the ui.mouse setting is on')
    .action(async (opts: { theme?: string; mouse?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals();
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        const msg = 'The Terminal Workbench needs an interactive terminal';
        if (g.json) process.stdout.write(JSON.stringify({ ok: false, error: { code: EXIT.usage, message: msg, hint: 'use non-interactive commands, e.g. synaptome status --json' } }) + '\n');
        else process.stderr.write(`error: ${msg}\n  hint: for scripts use the non-interactive commands, e.g. synaptome status --json (see synaptome --help)\n`);
        process.exitCode = EXIT.usage;
        return;
      }
      if (opts.theme && !['dark', 'light', 'auto'].includes(opts.theme)) {
        process.stderr.write(`error: unknown theme "${opts.theme}"\n  hint: use dark, light or auto\n`);
        process.exitCode = EXIT.usage;
        return;
      }
      const { runWorkbench } = await import('@synaptome/terminal-workbench');
      await runWorkbench({ home: g.home, theme: opts.theme, mouse: opts.mouse });
      // The terminal is already restored; do not let a lingering stdin handle keep the shell waiting.
      process.exit(process.exitCode ?? 0);
    });
}
