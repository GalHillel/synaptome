import path from 'node:path';
import type { Command } from 'commander';
import { PRODUCT, type Sys, env, openSystem, pathsFor, resolveHome, setOrigin } from '@synaptome/core';

/** Stable exit codes (documented in docs/INTERFACES.md). */
export const EXIT = { ok: 0, error: 1, usage: 2, blocked: 3, notFound: 4, unavailable: 5 } as const;

export class CliError extends Error {
  constructor(message: string, public code: number = EXIT.error, public hint?: string, public data?: unknown) {
    super(message);
  }
}

export interface Ctx {
  sys: Sys;
  json: boolean;
  /** Prints machine output when --json is set, otherwise the human rendering. */
  out(data: unknown, human: () => string): void;
}

/**
 * SQLite reports a damaged file as "malformed" (SQLITE_CORRUPT, 11) or "not a database" (SQLITE_NOTADB, 26). Say which
 * file, that nothing was changed, and that the folder must be copied before anything is tried: the main file often
 * still opens without its write-ahead log, and every repair attempt changes the files.
 */
export function damagedDatabase(e: any, home?: string): CliError | null {
  if (e?.code !== 'ERR_SQLITE_ERROR' || (e.errcode !== 11 && e.errcode !== 26)) return null;
  let dbFile: string = PRODUCT.dbFile;
  try {
    dbFile = pathsFor(resolveHome(home)).db;
  } catch {
    /* keep the bare name */
  }
  return new CliError(
    `The ${PRODUCT.name} database ${dbFile} is damaged (SQLite: ${e.errstr ?? e.message}). Nothing was changed.`,
    EXIT.error,
    `copy the whole folder ${path.dirname(dbFile)} somewhere safe before anything else; do not delete the ${PRODUCT.dbFile}-wal file. The main file may still open without its write-ahead log (try it on the copy); pre-upgrade and daily copies, if any, are in its backups folder`,
  );
}

/** Wraps a command action: opens the system, renders errors consistently, sets the exit code. */
export function action<A extends any[]>(fn: (ctx: Ctx, ...args: A) => Promise<void> | void) {
  return async (...args: any[]) => {
    const cmd: Command = args[args.length - 1];
    const g = cmd.optsWithGlobals();
    const json = !!g.json;
    let sys: Sys | undefined;
    try {
      setOrigin('cli');
      sys = openSystem(g.home);
      const ctx: Ctx = {
        sys,
        json,
        out(data, human) {
          process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : human() + '\n');
        },
      };
      await fn(ctx, ...(args as unknown as A)); // commander passes (...positionals, options, command)
    } catch (err: any) {
      const e = damagedDatabase(err, g.home) ?? err;
      const code = e instanceof CliError ? e.code : EXIT.error;
      const payload = { ok: false, error: { code, message: e?.message ?? String(e), hint: e?.hint, data: e?.data } };
      if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else process.stderr.write(`error: ${payload.error.message}${e?.hint ? `\n  hint: ${e.hint}` : ''}\n`);
      if (env('DEBUG') && e?.stack) process.stderr.write(e.stack + '\n');
      process.exitCode = code;
    } finally {
      try {
        sys?.close();
      } catch {
        /* already closed */
      }
    }
  };
}

/* ---------- plain-text table rendering for non-interactive output ---------- */

export function table(rows: Record<string, unknown>[], cols: { key: string; title?: string; max?: number }[]): string {
  if (!rows.length) return '(none)';
  const cell = (v: unknown) => (v == null ? '' : String(v));
  const widths = cols.map((c) => Math.min(c.max ?? 60, Math.max((c.title ?? c.key).length, ...rows.map((r) => cell(r[c.key]).length))));
  const fit = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
  const line = (vals: string[]) => vals.map((v, i) => fit(v, widths[i])).join('  ').trimEnd();
  return [line(cols.map((c) => (c.title ?? c.key).toUpperCase())), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c.key]))))].join('\n');
}

export const kv = (pairs: [string, unknown][]) => {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(w)}  ${v ?? ''}`).join('\n');
};
