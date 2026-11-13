/**
 * Phase 4 S5: the install lifecycle for Claude Code agents, commands and project MCP entries.
 * Disposable homes, a temporary stand-in for ~/.claude and a temporary project directory only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, buildAdapterRegistry, claudeCodeAdapter, mcpEntryFor, sidecarOf, treeDigest } from '@synaptome/adapters';
import { type CandidateDraft, type DiscoveryConnector, type FetchedFile, type Kind, getCandidate, getCapability, sha256, tempSystem } from '@synaptome/core';
import { ConnectorRegistry, scan, syncSources } from '@synaptome/discovery';
import { type Deps, applyUpdate, approve, evaluateCandidate, install, listInstallations, rollback, uninstall } from '../src/index';

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const f = (p: string, content: string): FetchedFile => ({ path: p, content, size: content.length });
const agentMd = (extra = '') => `---\nname: code-reviewer\ndescription: Reviews a diff for correctness problems and explains each finding. Use after a change is written.\ntools: Read, Grep, Glob\n---\nYou review code changes. For each problem, name the file and line, state the failure, and propose a fix.\n${'Prefer concrete findings over style remarks. '.repeat(10)}\n${extra}`;
const commandMd = (extra = '') => `---\ndescription: Summarise the staged changes as release notes grouped by type.\nargument-hint: [version]\n---\nSummarise the staged changes for release $ARGUMENTS. Group by Added, Changed, Fixed.\n${'Lead with what users notice. '.repeat(10)}\n${extra}`;
const serverJson = (over: Record<string, unknown> = {}) => JSON.stringify({ name: 'io.example/weather', description: 'Weather forecasts for a place and date', version: '1.2.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/weather' }], ...over }, null, 2);

let sys: ReturnType<typeof tempSystem>;
let claudeRoot: string;
let projectRoot: string;
let deps: Deps;
let upstream: Record<string, { kind: Kind; ref: string; files: FetchedFile[] }>;

function connector(): DiscoveryConnector {
  return {
    id: 'fx', kind: 'fixture', title: 'Fixture', description: '', official: false,
    health: async () => ({ ok: true, detail: 'ok', authenticated: false }),
    search: async () => ({
      drafts: Object.entries(upstream).map(([name, u]): CandidateDraft => ({ externalId: `acme/kit:${name}`, kind: u.kind, name, description: `${name} for code review, release notes and weather lookups`, repo: 'acme/kit', path: name, ref: u.ref, upstreamVersion: u.ref, publisher: 'acme', pushedAt: new Date().toISOString(), stars: 500, licenseSpdx: 'MIT' })),
    }),
    fetchPackage: async (c) => ({ files: upstream[c.path!].files, ref: c.ref ?? upstream[c.path!].ref, skipped: [], provenance: { url: `https://example.test/${c.path}@${c.ref}`, method: 'fixture pinned ref', verified: true } }),
    checkUpdate: async (c) => ({ changed: upstream[c.path!].ref !== c.ref, ref: upstream[c.path!].ref }),
  };
}

async function acquire(name: string): Promise<{ capId: string; candidateId: string }> {
  const r = await scan(sys, deps.connectors.get('fx'), { mode: 'broad' });
  const candidateId = r.candidateIds.find((id) => getCandidate(sys, id)!.path === name)!;
  const ev = await evaluateCandidate(sys, deps, candidateId);
  expect(ev.capabilityId, ev.summary).toBeTruthy();
  if (getCapability(sys, ev.capabilityId!)!.status !== 'approved') approve(sys, deps, ev.capabilityId!, { acceptLicence: 'test fixture' });
  return { capId: ev.capabilityId!, candidateId };
}
const sandbox = () => path.join(sys.paths.sandboxHosts, 'claude-code');
const NO_FILES = sha256('');
const fp = (d: string) => treeDigest(d) ?? NO_FILES;
const hosts = () => `${fp(sandbox())}|${fp(claudeRoot)}|${fp(projectRoot)}`;
const liveFor = (capId: string) => listInstallations(sys, { managedOnly: true, status: 'installed' }).filter((i) => i.capabilityId === capId);
const sandboxInstall = (capId: string) => install(sys, deps, capId, { host: 'claude-code', scope: 'sandbox' });
const ensureSandbox = (capId: string) => liveFor(capId).find((i) => i.scope === 'sandbox') ?? sandboxInstall(capId);

beforeEach(() => {
  sys = tempSystem();
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-project-'));
  deps = { connectors: new ConnectorRegistry().register(connector()), adapters: buildAdapterRegistry({ claudeRoot, projectRoot }) };
  syncSources(sys, deps.connectors);
  upstream = {
    'code-reviewer': { kind: 'agent', ref: 'a'.repeat(40), files: [f('code-reviewer.md', agentMd()), f('LICENSE', MIT)] },
    'release-notes': { kind: 'prompt', ref: 'b'.repeat(40), files: [f('release-notes.md', commandMd())] },
    weather: { kind: 'mcp-server', ref: '1.2.0', files: [f('server.json', serverJson())] },
  };
});
afterEach(() => {
  sys.dispose();
  for (const d of [claudeRoot, projectRoot]) fs.rmSync(d, { recursive: true, force: true });
});

describe.each([
  { name: 'code-reviewer', dir: 'agents', body: agentMd },
  { name: 'release-notes', dir: 'commands', body: commandMd },
])('single-file kind in $dir/', ({ name, dir, body }) => {
  const target = () => path.join(sandbox(), dir, `${name}.md`);

  it('installs as one Markdown file with an inert sidecar record, verified and fingerprinted', async () => {
    const { capId } = await acquire(name);
    const inst = ensureSandbox(capId);
    expect(inst.targetPath).toBe(target());
    expect(fs.readFileSync(target(), 'utf8')).toBe(body());
    expect(JSON.parse(fs.readFileSync(sidecarOf(target()), 'utf8'))).toMatchObject({ capabilityId: capId, managedBy: 'synaptome' });
    expect(fs.readdirSync(path.dirname(target())).filter((x) => x.endsWith('.md'))).toEqual([`${name}.md`]); // LICENSE did not land beside it
    expect(inst.verified).toBe(true);
    expect(inst.treeHash).toBeTruthy();
  });

  it('upgrade then rollback, and uninstall: byte-identical each time', async () => {
    const empty = hosts();
    const { capId, candidateId } = await acquire(name);
    const v1 = ensureSandbox(capId);
    const atV1 = hosts();
    upstream[name] = { ...upstream[name], ref: 'c'.repeat(40), files: [f(`${name}.md`, body('Second edition.'))] };
    await scan(sys, deps.connectors.get('fx'), { mode: 'incremental' });
    await applyUpdate(sys, deps, candidateId);
    if (getCapability(sys, capId)!.status !== 'approved') approve(sys, deps, capId, { acceptLicence: 'test fixture' });
    const v2 = sandboxInstall(capId); // the new version (a no-op if the update already installed it)
    expect(v2.previousId).toBe(v1.id);
    expect(fs.readFileSync(target(), 'utf8')).toContain('Second edition.');
    expect(rollback(sys, deps, v2.id).restored).toBe(v1.id);
    expect(hosts()).toBe(atV1);
    uninstall(sys, deps, v1.id);
    expect(hosts()).toBe(empty);
  });

  it('an edited file is never removed silently', async () => {
    const { capId } = await acquire(name);
    const inst = ensureSandbox(capId);
    fs.appendFileSync(target(), '\nmy note\n');
    const before = hosts();
    expect(() => uninstall(sys, deps, inst.id)).toThrow(/changed after Synaptome installed it/);
    expect(hosts()).toBe(before);
    const r = uninstall(sys, deps, inst.id, { force: true });
    expect(fs.readFileSync(path.join(r.preserved!, 'file'), 'utf8')).toContain('my note');
  });

  it('a failed install leaves nothing behind', async () => {
    const { capId } = await acquire(name);
    for (const i of liveFor(capId)) uninstall(sys, deps, i.id);
    const before = hosts();
    const base = claudeCodeAdapter({ claudeRoot, projectRoot });
    const broken = new AdapterRegistry().register({ ...base, verify: () => ({ ok: false, detail: 'simulated' }) });
    expect(() => install(sys, { ...deps, adapters: broken }, capId, { host: 'claude-code', scope: 'sandbox' })).toThrow(/reverted/);
    expect(hosts()).toBe(before);
  });

  it("a user's own file at the same path in the real host is never touched", async () => {
    const mine = path.join(claudeRoot, dir, `${name}.md`);
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, 'my own file');
    const { capId } = await acquire(name);
    ensureSandbox(capId);
    const before = hosts();
    expect(() => install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/already exists and was not installed by Synaptome/);
    expect(hosts()).toBe(before);
    expect(fs.readFileSync(mine, 'utf8')).toBe('my own file');
  });
});

describe('agent- and command-specific conflicts', () => {
  it("refuses an agent whose name another agent file already uses (the host would load only one)", async () => {
    fs.mkdirSync(path.join(claudeRoot, 'agents', 'team'), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, 'agents', 'team', 'my-reviewer.md'), '---\nname: code-reviewer\ndescription: mine\n---\nmine');
    const { capId } = await acquire('code-reviewer');
    ensureSandbox(capId);
    const before = hosts();
    expect(() => install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/an agent named "code-reviewer" already exists/);
    expect(hosts()).toBe(before);
  });

  it('refuses a command shadowed by a skill of the same name', async () => {
    fs.mkdirSync(path.join(claudeRoot, 'skills', 'release-notes'), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: mine\n---\nmine');
    const { capId } = await acquire('release-notes');
    ensureSandbox(capId);
    expect(() => install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/would take precedence over this command/);
  });

  it('refuses an agent package that carries more than its Markdown file and licence', async () => {
    upstream['code-reviewer'].files = [f('code-reviewer.md', agentMd()), f('scripts/setup.sh', 'echo hi'), f('LICENSE', MIT)];
    const { capId } = await acquire('code-reviewer');
    expect(() => sandboxInstall(capId)).toThrow(/installs as one Markdown file, but the package also contains scripts\/setup.sh/);
    expect(fs.existsSync(path.join(sandbox(), 'agents'))).toBe(false);
  });
});

describe('project MCP entries (.mcp.json)', () => {
  const mcpFile = () => path.join(projectRoot, '.mcp.json');
  /** The user's own configuration, deliberately formatted differently from JSON.stringify(…, 2). */
  const USER_CONFIG = '{\n    "mcpServers": {\n        "mine": { "command": "my-server", "args": ["--port", "7000"] }\n    }\n}\n';

  it('derives entries from registry records: remote preferred, pinned packages otherwise, secrets as references', () => {
    expect(mcpEntryFor([f('server.json', serverJson())]).entry).toEqual({ type: 'http', url: 'https://mcp.example.test/weather' });
    const auth = mcpEntryFor([f('server.json', serverJson({ remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }] }))]);
    expect(auth.entry.headers).toEqual({ Authorization: 'Bearer ${SYNAPTOME_MCP_IO_EXAMPLE_WEATHER_AUTHORIZATION}' });
    const npm = mcpEntryFor([f('server.json', serverJson({ remotes: [], packages: [{ registryType: 'npm', identifier: '@example/weather-mcp', version: '1.2.0', environmentVariables: [{ name: 'WEATHER_KEY', isRequired: true, isSecret: true }] }] }))]);
    expect(npm).toEqual({ entry: { type: 'stdio', command: 'npx', args: ['-y', '@example/weather-mcp@1.2.0'], env: { WEATHER_KEY: '${WEATHER_KEY}' } }, needs: ['WEATHER_KEY'] });
    expect(() => mcpEntryFor([f('server.json', serverJson({ remotes: [], packages: [{ registryType: 'npm', identifier: 'x', version: '^1.0.0' }] }))])).toThrow(/no pinned version/);
    expect(() => mcpEntryFor([f('server.json', serverJson({ remotes: [{ type: 'streamable-http', url: 'http://plain.test/mcp' }] }))])).toThrow(/neither an https endpoint/);
  });

  it("adds one entry beside the user's own and, on uninstall, restores the file byte for byte", async () => {
    fs.writeFileSync(mcpFile(), USER_CONFIG);
    const before = hosts();
    const { capId } = await acquire('weather');
    ensureSandbox(capId);
    const real = install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true });
    expect(real.targetPath).toBe(`${mcpFile()}#weather`);
    const cfg = JSON.parse(fs.readFileSync(mcpFile(), 'utf8'));
    expect(cfg.mcpServers).toEqual({ mine: { command: 'my-server', args: ['--port', '7000'] }, weather: { type: 'http', url: 'https://mcp.example.test/weather' } });
    expect(real.verifyDetail).toMatch(/asks the user before it first starts a project server/);
    uninstall(sys, deps, real.id);
    expect(fs.readFileSync(mcpFile(), 'utf8')).toBe(USER_CONFIG);
    expect(fs.existsSync(sidecarOf(mcpFile()))).toBe(false);
    for (const i of liveFor(capId)) uninstall(sys, deps, i.id);
    expect(hosts()).toBe(before);
  });

  it('keeps changes the user made to other servers after the install', async () => {
    fs.writeFileSync(mcpFile(), USER_CONFIG);
    const { capId } = await acquire('weather');
    ensureSandbox(capId);
    const real = install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true });
    const cfg = JSON.parse(fs.readFileSync(mcpFile(), 'utf8'));
    cfg.mcpServers.mine.args = ['--port', '8000'];
    fs.writeFileSync(mcpFile(), JSON.stringify(cfg));
    uninstall(sys, deps, real.id); // not an edit of Synaptome's entry, so no refusal
    expect(JSON.parse(fs.readFileSync(mcpFile(), 'utf8')).mcpServers).toEqual({ mine: { command: 'my-server', args: ['--port', '8000'] } });
  });

  it("never replaces the user's entry of the same name, never writes into invalid JSON, and refuses to remove an edited entry", async () => {
    fs.writeFileSync(mcpFile(), '{"mcpServers":{"weather":{"command":"their-weather"}}}');
    const { capId } = await acquire('weather');
    ensureSandbox(capId);
    const own = fs.readFileSync(mcpFile(), 'utf8');
    expect(() => install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/already exists and was not installed by Synaptome/);
    expect(fs.readFileSync(mcpFile(), 'utf8')).toBe(own);

    fs.writeFileSync(mcpFile(), '{ "mcpServers": { broken');
    expect(() => install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/is not valid JSON; fix it before installing into it/);
    expect(fs.readFileSync(mcpFile(), 'utf8')).toBe('{ "mcpServers": { broken');

    fs.rmSync(mcpFile());
    const real = install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true });
    const cfg = JSON.parse(fs.readFileSync(mcpFile(), 'utf8'));
    cfg.mcpServers.weather.url = 'https://elsewhere.test/mcp';
    fs.writeFileSync(mcpFile(), JSON.stringify(cfg, null, 2));
    expect(() => uninstall(sys, deps, real.id)).toThrow(/changed after Synaptome installed it/);
    expect(JSON.parse(fs.readFileSync(mcpFile(), 'utf8')).mcpServers.weather.url).toBe('https://elsewhere.test/mcp');
  });

  it('upgrade then rollback restores the earlier entry byte for byte; a fresh install then uninstall removes the file it created', async () => {
    const empty = hosts();
    const { capId, candidateId } = await acquire('weather');
    const v1 = ensureSandbox(capId);
    const atV1 = hosts();
    upstream.weather = { kind: 'mcp-server', ref: '1.3.0', files: [f('server.json', serverJson({ version: '1.3.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/weather/v2' }] }))] };
    await scan(sys, deps.connectors.get('fx'), { mode: 'incremental' });
    await applyUpdate(sys, deps, candidateId);
    if (getCapability(sys, capId)!.status !== 'approved') approve(sys, deps, capId, { acceptLicence: 'test fixture' });
    const v2 = sandboxInstall(capId);
    expect(v2.previousId).toBe(v1.id);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox(), 'project', '.mcp.json'), 'utf8')).mcpServers.weather.url).toMatch(/\/v2$/);
    expect(rollback(sys, deps, v2.id).restored).toBe(v1.id);
    expect(hosts()).toBe(atV1);
    uninstall(sys, deps, v1.id);
    expect(hosts()).toBe(empty);
    expect(fs.existsSync(path.join(sandbox(), 'project', '.mcp.json'))).toBe(false);
  });

  it('a failed MCP install leaves the configuration exactly as it was', async () => {
    fs.writeFileSync(mcpFile(), USER_CONFIG);
    const { capId } = await acquire('weather');
    ensureSandbox(capId);
    const before = hosts();
    const base = claudeCodeAdapter({ claudeRoot, projectRoot });
    const broken = new AdapterRegistry().register({ ...base, verify: () => ({ ok: false, detail: 'simulated' }) });
    expect(() => install(sys, { ...deps, adapters: broken }, capId, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/reverted/);
    expect(hosts()).toBe(before);
  });

  it('never targets user-scope configuration: without a project, real MCP installs are refused', async () => {
    deps = { ...deps, adapters: buildAdapterRegistry({ claudeRoot }) };
    const { capId } = await acquire('weather');
    ensureSandbox(capId);
    expect(() => install(sys, deps, capId, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/installed only into a project/);
  });
});
