import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/main';

// Every `synaptome …` command written in the public docs must exist, with the options it is shown with (Phase 12:
// "docs commands executed as tests"; the quick start itself is executed by scripts/clean-room.ps1).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCS = ['README.md', 'packaging/README.md', 'docs/INSTALL.md', 'docs/QUICKSTART.md', 'docs/RELEASE_NOTES_0.2.0.md', 'INSTALLATION.md'];

/** Command lines in code blocks and inline code that start with the program name. */
function commandLines(md: string): string[] {
  const out: string[] = [];
  for (const block of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const line of block[1].split('\n')) if (/^\s*synaptome(\s|$)/.test(line)) out.push(line.trim());
  for (const span of md.replace(/```[\s\S]*?```/g, '').matchAll(/`(synaptome(?:\s[^`]*)?)`/g)) out.push(span[1].trim());
  return out;
}
/** Tokens of one command line: comments, quoted text and <placeholders> removed. */
function tokens(line: string): string[] {
  return line
    .replace(/\s#.*$/, '')
    .replace(/"[^"]*"|'[^']*'/g, ' ARG ')
    .replace(/<[^>]+>/g, ' ARG ')
    .replace(/\[[^\]]*\]/g, ' ') // [optional parts] of a usage template
    .split(/\s+/)
    .filter(Boolean)
    .slice(1);
}
function check(program: Command, line: string): string[] {
  const problems: string[] = [];
  let cmd = program;
  const chain: Command[] = [program];
  let positional = false;
  for (const t of tokens(line)) {
    if (t.startsWith('-')) {
      const name = t.split('=')[0];
      const known = chain.some((c) => c.options.some((o) => o.long === name || o.short === name)) || ['--help', '-h', '--version', '-V'].includes(name);
      if (!known) problems.push(`${line}: unknown option ${name} for "${cmd.name()}"`);
      continue;
    }
    if (positional) continue;
    if (t === 'ARG') {
      positional = true; // `synaptome <command>`: a usage template, not a command
      continue;
    }
    const sub = cmd.commands.find((c) => c.name() === t || c.aliases().includes(t));
    if (sub) {
      cmd = sub;
      chain.push(sub);
    } else if (cmd === program) problems.push(`${line}: unknown command "${t}"`);
    else positional = true;
  }
  return problems;
}

describe('public documentation', () => {
  it('only shows commands and options that exist', () => {
    const program = buildProgram();
    const lines = DOCS.flatMap((f) => commandLines(fs.readFileSync(path.join(ROOT, f), 'utf8')).map((l) => ({ f, l })));
    expect(lines.length).toBeGreaterThan(30);
    const problems = lines.flatMap(({ f, l }) => check(program, l).map((p) => `${f}: ${p}`));
    expect(problems).toEqual([]);
  });
});
