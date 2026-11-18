import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { read, readJson, syn, tempDir, writeJson } from './harness';

// Connecting a project and disconnecting it must never lose anything the user wrote (plan NG, M1; audit B1, B2).
// Tests marked `it.fails` reproduce a confirmed defect: they assert the correct behaviour and currently fail. When the
// fix lands the test starts passing, `it.fails` then reports an error, and the test is flipped to `it`.
const skillFile = (p: string) => path.join(p, '.claude', 'skills', 'synaptome', 'SKILL.md');

function connected() {
  const home = tempDir('home');
  const project = tempDir('project');
  const r = syn(home, ['bridge', 'init', project]);
  expect(r.code, r.err).toBe(0);
  return { home, project };
}

/** A project as Synaptome 0.2.0 connected it, reconstructed from its documented record format (format 1). */
function connectedBy020() {
  const home = tempDir('home');
  const project = tempDir('project');
  expect(syn(home, ['status']).code).toBe(0);
  const launcher = path.join(home, 'old-launcher.mjs');
  const cli = `node "${launcher.replace(/\\/g, '/')}" --home "${home.replace(/\\/g, '/')}"`;
  writeJson(path.join(project, '.mcp.json'), { mcpServers: { synaptome: { command: 'node', args: [launcher, '--home', home, 'mcp'] }, mine: { command: 'node', args: ['mine.js'] } } });
  writeJson(path.join(project, '.claude', 'settings.local.json'), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${cli} hook user-prompt`, timeout: 20 }] }] }, permissions: { allow: ['Bash(ls)'] } });
  fs.mkdirSync(path.join(project, '.claude', 'skills', 'synaptome'), { recursive: true });
  fs.writeFileSync(skillFile(project), 'an old bridge skill the user rewrote');
  writeJson(path.join(project, '.synaptome-bridge.json'), { createdMcp: true, mcpPath: path.join(project, '.mcp.json'), skillPath: skillFile(project), home, at: '2026-11-12T10:46:00Z', hook: { settingsPath: path.join(project, '.claude', 'settings.local.json'), createdSettings: true, command: `${cli} hook user-prompt` } });
  return { home, project };
}

describe('bridge ownership', () => {
  it('connects a project: MCP entry, bridge skill and prompt hook, all inside the project', () => {
    const { project } = connected();
    expect(readJson(path.join(project, '.mcp.json')).mcpServers.synaptome).toBeTruthy();
    expect(fs.existsSync(skillFile(project))).toBe(true);
    expect(JSON.stringify(readJson(path.join(project, '.claude', 'settings.local.json')).hooks.UserPromptSubmit)).toContain('hook user-prompt');
  });

  it('a project that already had .mcp.json keeps its own servers when disconnected', () => {
    const home = tempDir('home');
    const project = tempDir('project');
    writeJson(path.join(project, '.mcp.json'), { mcpServers: { mine: { command: 'node', args: ['mine.js'] } } });
    expect(syn(home, ['bridge', 'init', project]).code).toBe(0);
    expect(syn(home, ['bridge', 'remove', project]).code).toBe(0);
    expect(readJson(path.join(project, '.mcp.json')).mcpServers).toEqual({ mine: { command: 'node', args: ['mine.js'] } });
  });

  it('B1 fixed: a server the user added after connecting survives disconnecting', () => {
    const { home, project } = connected();
    const mcp = readJson(path.join(project, '.mcp.json'));
    mcp.mcpServers.mine = { command: 'node', args: ['mine.js'] };
    writeJson(path.join(project, '.mcp.json'), mcp);
    expect(syn(home, ['bridge', 'remove', project]).code).toBe(0);
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(true);
    expect(readJson(path.join(project, '.mcp.json')).mcpServers).toEqual({ mine: { command: 'node', args: ['mine.js'] } });
  });

  it('B2 fixed: a bridge skill the user edited is kept, not deleted', () => {
    const { home, project } = connected();
    fs.appendFileSync(skillFile(project), '\n## My own notes\nkeep me\n');
    syn(home, ['bridge', 'remove', project]);
    expect(read(skillFile(project))).toContain('keep me');
  });

  it('B2 fixed: a file the user added next to the bridge skill is kept', () => {
    const { home, project } = connected();
    fs.writeFileSync(path.join(path.dirname(skillFile(project)), 'notes.md'), 'mine');
    syn(home, ['bridge', 'remove', project]);
    expect(read(path.join(path.dirname(skillFile(project)), 'notes.md'))).toBe('mine');
  });

  it('a hook the user added to the same event survives disconnecting', () => {
    const { home, project } = connected();
    const f = path.join(project, '.claude', 'settings.local.json');
    const s = readJson(f);
    s.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'echo mine' }] });
    writeJson(f, s);
    expect(syn(home, ['bridge', 'remove', project]).code).toBe(0);
    expect(JSON.stringify(readJson(f))).toContain('echo mine');
    expect(JSON.stringify(readJson(f))).not.toContain('hook user-prompt');
  });

  it('an unreadable settings file stops disconnecting before anything changes', () => {
    const { home, project } = connected();
    const files = ['.mcp.json', '.synaptome-bridge.json', '.claude/skills/synaptome/SKILL.md'].map((f) => path.join(project, f));
    const before = files.map((f) => read(f));
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{ not json');
    const r = syn(home, ['bridge', 'remove', project]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/not valid JSON/);
    expect(files.map((f) => read(f))).toEqual(before);
    expect(read(path.join(project, '.claude', 'settings.local.json'))).toBe('{ not json');
  });

  it('a project connected by version 0.2.0 (record format 1) is disconnected without losing servers the user added', () => {
    const { home, project } = connectedBy020();
    const r = syn(home, ['--json', 'bridge', 'remove', project]);
    expect(r.code, r.err).toBe(0);
    expect(readJson(path.join(project, '.mcp.json')).mcpServers).toEqual({ mine: { command: 'node', args: ['mine.js'] } });
    expect(readJson(path.join(project, '.claude', 'settings.local.json'))).toEqual({ permissions: { allow: ['Bash(ls)'] } });
    expect(read(skillFile(project))).toBe('an old bridge skill the user rewrote');
    expect(r.json.kept.join(' ')).toMatch(/SKILL.md/);
  });

  it('a project connected by version 0.2.0 is updated in place: the user\'s server, settings and edited skill stay (0.2.1 upgrade path)', () => {
    const { home, project } = connectedBy020();
    const r = syn(home, ['--json', 'bridge', 'update', project]);
    expect(r.code, r.err).toBe(0);
    const servers = readJson(path.join(project, '.mcp.json')).mcpServers;
    expect(servers.mine).toEqual({ command: 'node', args: ['mine.js'] });
    expect(JSON.stringify(servers.synaptome)).not.toContain('old-launcher.mjs'); // points at the running copy now
    expect(read(skillFile(project))).toBe('an old bridge skill the user rewrote');
    expect(readJson(path.join(project, '.claude', 'settings.local.json')).permissions).toEqual({ allow: ['Bash(ls)'] });
    // The record is now the hashed format; disconnecting afterwards still keeps the user's server and skill.
    expect(syn(home, ['bridge', 'remove', project]).code).toBe(0);
    expect(readJson(path.join(project, '.mcp.json')).mcpServers).toEqual({ mine: { command: 'node', args: ['mine.js'] } });
    expect(read(skillFile(project))).toBe('an old bridge skill the user rewrote');
  });

  it('update keeps a skill the user edited and restores a missing MCP entry', () => {
    const { home, project } = connected();
    fs.appendFileSync(skillFile(project), 'my addition');
    const mcp = readJson(path.join(project, '.mcp.json'));
    delete mcp.mcpServers.synaptome;
    mcp.mcpServers.mine = { command: 'x' };
    writeJson(path.join(project, '.mcp.json'), mcp);
    const r = syn(home, ['--json', 'bridge', 'update', project]);
    expect(r.code, r.err).toBe(0);
    expect(read(skillFile(project))).toContain('my addition');
    expect(Object.keys(readJson(path.join(project, '.mcp.json')).mcpServers).sort()).toEqual(['mine', 'synaptome']);
    // The edited skill is now the user's: disconnecting keeps it.
    expect(syn(home, ['bridge', 'remove', project]).code).toBe(0);
    expect(read(skillFile(project))).toContain('my addition');
    expect(readJson(path.join(project, '.mcp.json')).mcpServers).toEqual({ mine: { command: 'x' } });
  });

  it('status is read-only and reports each part', () => {
    const { home, project } = connected();
    const snapshot = () => fs.readdirSync(project, { recursive: true }).map(String).sort().map((f) => [f, fs.statSync(path.join(project, f)).isFile() ? read(path.join(project, f)) : 'dir']);
    const before = snapshot();
    const r = syn(home, ['--json', 'bridge', 'status', project]);
    expect(r.code, r.err).toBe(0);
    expect(r.json).toMatchObject({ connected: true, format: 2, status: 'installed' });
    expect(r.json.parts.map((p: any) => p.state)).toEqual(['ok', 'ok', 'ok']);
    expect(snapshot()).toEqual(before);
  });

  it('a project left half-connected by an interrupted run can still be disconnected cleanly', () => {
    const { home, project } = connected();
    const rec = readJson(path.join(project, '.synaptome-bridge.json'));
    rec.status = 'installing';
    writeJson(path.join(project, '.synaptome-bridge.json'), rec);
    fs.rmSync(skillFile(project)); // the run stopped before writing the skill
    expect(syn(home, ['bridge', 'remove', project]).code).toBe(0);
    expect(fs.readdirSync(project)).toEqual([]);
  });
});
