import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSystem, upsertCapability, writeSnapshot } from '@synaptome/core';

// Tests here start the real CLI up to nine times in a row; on a fresh checkout under a full parallel run that exceeded
// the default 20 s limit (observed in a clean copy of the public tree).
vi.setConfig({ testTimeout: 90_000 });

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'synaptome.mjs');
let home: string;
let project: string;

/** Runs the real CLI as a host would: a separate process, optional stdin. */
function cli(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, '--home', home, ...args], { encoding: 'utf8', input, env: { ...process.env, SYNAPTOME_CLAUDE_ROOT: path.join(home, 'no-claude'), ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-project-'));
  const sys = openSystem(home);
  const files = [{ path: 'SKILL.md', content: '---\nname: internal-comms\ndescription: Write internal communications such as status reports, leadership updates and 3P updates\n---\n# Internal comms\nLEAD-WITH-PROGRESS-PLANS-PROBLEMS', size: 1 }];
  upsertCapability(sys, { id: 'acme.internal-comms', name: 'internal-comms', description: 'Write internal communications such as status reports, leadership updates and 3P updates', kind: 'skill', domain: 'docs', tags: ['status', 'leadership', '3p'], entryFile: 'SKILL.md' }, { status: 'approved', ...writeSnapshot(sys, 'acme.internal-comms', files), body: files[0].content });
  sys.close();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

const settingsFile = () => path.join(project, '.claude', 'settings.local.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('prompt hook and Synaptome\'s own model calls', () => {
  it('stays silent for prompts that come from a model call Synaptome itself made (no self-routing, no gap records)', () => {
    const payload = JSON.stringify({ prompt: 'Write a 3P status update for the leadership team about this week' });
    expect(cli(['hook', 'user-prompt'], payload).out).toMatch(/internal-comms/);
    const internal = cli(['hook', 'user-prompt'], payload, { SYNAPTOME_INTERNAL_CALL: '1' });
    expect(internal).toMatchObject({ code: 0, out: '' });
  });
});

describe('project bridge', () => {
  it('installs MCP config, bridge skill and a UserPromptSubmit hook, and removes exactly those', () => {
    expect(cli(['bridge', 'init', project]).code).toBe(0);
    expect(read(path.join(project, '.mcp.json')).mcpServers.synaptome.args).toContain('mcp');
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'synaptome', 'SKILL.md'))).toBe(true);
    const entry = read(settingsFile()).hooks.UserPromptSubmit[0].hooks[0];
    expect(entry).toMatchObject({ type: 'command', timeout: 20 });
    expect(entry.command).toMatch(/hook user-prompt$/);
    expect(cli(['bridge', 'init', project]).code).toBe(3); // already initialised
    expect(cli(['bridge', 'remove', project]).code).toBe(0);
    expect(fs.readdirSync(project)).toEqual([]); // nothing left behind
  });

  it('preserves existing local settings and hooks when adding and removing its own entry', () => {
    fs.mkdirSync(path.join(project, '.claude'));
    const mine = { permissions: { allow: ['Bash(npm test)'] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
    fs.writeFileSync(settingsFile(), JSON.stringify(mine));
    expect(cli(['bridge', 'init', project]).code).toBe(0);
    expect(read(settingsFile()).hooks.UserPromptSubmit).toHaveLength(2);
    expect(cli(['bridge', 'remove', project]).code).toBe(0);
    expect(read(settingsFile())).toEqual(mine);
  });

  it('can skip the hook, and refuses to touch a settings file it cannot parse', () => {
    expect(cli(['bridge', 'init', project, '--no-hook']).code).toBe(0);
    expect(fs.existsSync(settingsFile())).toBe(false);
    cli(['bridge', 'remove', project]);
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ not json');
    const r = cli(['bridge', 'init', project]);
    expect(r.code).toBe(3);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{ not json');
  });
});

describe('UserPromptSubmit hook', () => {
  const payload = (prompt: string) => JSON.stringify({ session_id: 's', hook_event_name: 'UserPromptSubmit', cwd: project, prompt });

  it('offers a compact summary of the routed capability, within budget, and loads the full text only on demand', () => {
    const r = cli(['hook', 'user-prompt'], payload('Write a 3P status update for the leadership team about the billing migration'));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('internal-comms [acme.internal-comms]');
    expect(ctx).toContain('Write internal communications'); // the summary
    expect(ctx).not.toContain('LEAD-WITH-PROGRESS-PLANS-PROBLEMS'); // never the capability body
    expect(ctx).toMatch(/user's instructions take precedence/);
    expect(Math.ceil(ctx.length / 4)).toBeLessThanOrEqual(800);

    // offering is not activating
    expect(JSON.parse(cli(['activations', '--json']).out)).toEqual([]);
    const decision = JSON.parse(cli(['decisions', '--json']).out)[0];
    expect(decision.origin).toBe('hook');
    expect(decision.metrics.injectedTokens).toBe(Math.ceil(ctx.length / 4));
    expect(decision.metrics.offered).toEqual(['acme.internal-comms']);
    expect(decision.metrics.hookMs).toBeGreaterThanOrEqual(0);

    // the load command from the summary serves the full text and records the activation
    const loaded = cli(['activate', 'acme.internal-comms', '--decision', String(decision.id)]);
    expect(loaded.out).toContain('LEAD-WITH-PROGRESS-PLANS-PROBLEMS');
    expect(JSON.parse(cli(['activations', '--json']).out)[0]).toMatchObject({ capability_id: 'acme.internal-comms', decision_id: decision.id });
  });

  it('ignores host-added reminder blocks when routing a prompt', () => {
    const wrapped = '<system-reminder>Write a 3P status update for the leadership team about the billing migration</system-reminder> thanks, that works';
    const r = cli(['hook', 'user-prompt'], payload(wrapped));
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });

  it('stays silent and exits 0 for trivial, unmatched, slash-command and malformed input', () => {
    for (const input of [payload('Fix the null check in the Python date parser'), payload('thanks'), payload('commit the status update file'), payload('what did you just change in the leadership update?'), payload('/compact'), payload('Translate this paragraph into formal Japanese'), 'not json at all', '']) {
      const r = cli(['hook', 'user-prompt'], input);
      expect(r.code, input).toBe(0);
      expect(r.out, input).toBe('');
    }
    expect(JSON.parse(cli(['activations', '--json']).out)).toEqual([]);
  });
});
