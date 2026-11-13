import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempSystem } from '@synaptome/core';
import { type FetchLike, buildConnectorRegistry, createGitHubConnector, createLocalClaudeConnector, createMcpRegistryConnector, createNpmConnector, createRepoListConnector, createSkillsShConnector, detectUnits, repositoryLinks } from '../src/index';

/** Fake HTTP: ordered [pattern, responder] routes; records every requested URL. */
function fakeFetch(routes: [RegExp, (url: string, headers: Record<string, string>) => { status?: number; body: unknown; headers?: Record<string, string> }][]) {
  const calls: string[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push(url);
    const route = routes.find(([re]) => re.test(url));
    const r = route ? route[1](url, init?.headers ?? {}) : { status: 404, body: { message: 'Not Found' } };
    const headers: Record<string, string> = { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '25', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60), ...(r.headers ?? {}) };
    const status = r.status ?? 200;
    return { status, ok: status >= 200 && status < 300, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { impl, calls };
}

const COMMIT = 'c'.repeat(40);
const repo = { full_name: 'acme/skills', description: 'Acme agent skills', default_branch: 'main', stargazers_count: 900, pushed_at: '2026-10-01T00:00:00Z', topics: ['agent-skills'], archived: false, fork: false, license: { spdx_id: 'MIT' }, owner: { login: 'acme' }, html_url: 'https://github.com/acme/skills' };
const tree = {
  sha: 'roottree', truncated: false,
  tree: [
    { path: 'pdf', type: 'tree', sha: 'pdftree' },
    { path: 'pdf/SKILL.md', type: 'blob', sha: 'b1', size: 120 },
    { path: 'pdf/scripts/run.py', type: 'blob', sha: 'b2', size: 40 },
    { path: 'pdf/logo.png', type: 'blob', sha: 'b3', size: 999 },
    { path: 'agents/reviewer.md', type: 'blob', sha: 'b4', size: 80 },
    { path: 'README.md', type: 'blob', sha: 'b5', size: 10 },
  ],
};
const githubRoutes = (): Parameters<typeof fakeFetch>[0] => [
  [/\/rate_limit$/, () => ({ body: { resources: { core: { limit: 5000, remaining: 4990, reset: 1 }, search: { limit: 30, remaining: 30, reset: 1 } } } })],
  [/\/search\/repositories/, () => ({ body: { total_count: 1, items: [repo] }, headers: { 'x-ratelimit-resource': 'search' } })],
  [/\/commits\/main$/, () => ({ body: COMMIT })],
  [/\/git\/trees\//, () => ({ body: tree })],
  [/\/git\/blobs\/b1$/, () => ({ body: '---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF\n' })],
  [/\/git\/blobs\/b2$/, () => ({ body: 'print("hi")\n' })],
  [/\/git\/blobs\/b4$/, () => ({ body: '---\nname: reviewer\ndescription: Reviews code\n---\nYou review.' })],
  [/\/license/, () => ({ body: { path: 'LICENSE', license: { spdx_id: 'MIT' }, content: Buffer.from('MIT License\n\nCopyright (c) Acme').toString('base64') } })],
  [/\/repos\/acme\/skills$/, () => ({ body: repo })],
];

let sys: ReturnType<typeof tempSystem> | undefined;
afterEach(() => {
  sys?.dispose();
  sys = undefined;
});

describe('unit detection', () => {
  it('finds skills, agents, plugins, prompts, workflows, hooks and MCP manifests, not only SKILL.md', () => {
    const units = detectUnits(['skills/a/SKILL.md', 'skills/a/ref.md', '.claude-plugin/plugin.json', 'agents/x.md', 'agents/README.md', 'commands/go.md', 'workflows/ship.yaml', '.github/workflows/ci.yml', 'hooks/hooks.json', 'server.json', 'node_modules/z/SKILL.md', 'tests/fixtures/SKILL.md']);
    expect(units.map((u) => `${u.kind}:${u.path}`).sort()).toEqual(['agent:agents/x.md', 'hook:hooks', 'mcp-server:', 'plugin:', 'prompt:commands/go.md', 'skill:skills/a', 'workflow:workflows/ship.yaml']);
  });
});

describe('GitHub connector', () => {
  it('expands repositories into pinned, described units with licence evidence', async () => {
    const { impl } = fakeFetch(githubRoutes());
    const gh = createGitHubConnector({ fetchImpl: impl, token: 't' });
    expect((await gh.health()).ok).toBe(true);
    const r = await gh.search({ mode: 'need', query: 'pdf', limit: 10 });
    const skill = r.drafts.find((d) => d.kind === 'skill')!;
    expect(skill).toMatchObject({ externalId: 'acme/skills:pdf#skill', name: 'pdf', description: 'Work with PDF files', ref: COMMIT, upstreamVersion: 'pdftree', licenseSpdx: 'MIT', publisher: 'acme', path: 'pdf' });
    expect(r.drafts.find((d) => d.kind === 'agent')).toMatchObject({ name: 'reviewer', path: 'agents/reviewer.md' });
    expect(r.notes!.join(' ')).toMatch(/API calls this scan/);
  });

  it('fetches a unit at its pinned commit, skips binaries and attaches the upstream licence', async () => {
    const { impl, calls } = fakeFetch(githubRoutes());
    const gh = createGitHubConnector({ fetchImpl: impl, token: 't' });
    const pkg = await gh.fetchPackage({ externalId: 'acme/skills:pdf#skill', repo: 'acme/skills', ref: COMMIT, path: 'pdf', raw: { isDir: true } });
    expect(pkg.files.map((f) => f.path).sort()).toEqual(['.upstream/LICENSE', 'SKILL.md', 'scripts/run.py']);
    expect(pkg.skipped).toEqual([{ path: 'logo.png', reason: 'binary file not fetched' }]);
    expect(pkg.license).toMatchObject({ spdx: 'MIT' });
    expect(pkg.provenance.verified).toBe(true);
    expect(calls.some((u) => u.includes(`/git/trees/${COMMIT}`))).toBe(true);
  });

  it('stops at the search rate limit and keeps partial results instead of failing', async () => {
    let n = 0;
    const routes = githubRoutes();
    routes[1] = [/\/search\/repositories/, () => (++n === 1 ? { body: { total_count: 1, items: [repo] }, headers: { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '1' } } : { status: 403, body: { message: 'rate limited' }, headers: { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '0' } })];
    const { impl, calls } = fakeFetch(routes);
    const gh = createGitHubConnector({ fetchImpl: impl, token: 't' });
    const r = await gh.search({ mode: 'broad', limit: 50 });
    expect(r.drafts.length).toBeGreaterThan(0);
    expect(r.notes!.join(' ')).toMatch(/stopped early: GitHub search rate limit/);
    expect(calls.filter((u) => u.includes('/search/')).length).toBe(1); // the floor prevented a second search call
  });

  it('reuses ETag-cached responses', async () => {
    sys = tempSystem();
    const routes = githubRoutes();
    routes[3] = [/\/git\/trees\//, (_u, h) => (h['If-None-Match'] === '"v1"' ? { status: 304, body: '' } : { body: tree, headers: { etag: '"v1"' } })];
    const { impl } = fakeFetch(routes);
    const gh = createGitHubConnector({ fetchImpl: impl, token: 't', cacheDir: path.join(sys.paths.cache, 'gh') });
    await gh.search({ mode: 'need', query: 'repo:acme/skills', limit: 5 });
    await gh.search({ mode: 'need', query: 'repo:acme/skills', limit: 5 });
    expect(gh.client.cacheHits).toBe(1);
  });

  it('detects upstream changes per unit by tree sha', async () => {
    const { impl } = fakeFetch(githubRoutes());
    const gh = createGitHubConnector({ fetchImpl: impl, token: 't' });
    const base = { externalId: 'x', repo: 'acme/skills', path: 'pdf', raw: { defaultBranch: 'main' } };
    expect((await gh.checkUpdate!({ ...base, ref: COMMIT, upstreamVersion: 'pdftree' })).changed).toBe(false);
    expect((await gh.checkUpdate!({ ...base, ref: 'd'.repeat(40), upstreamVersion: 'pdftree' })).changed).toBe(false);
    expect((await gh.checkUpdate!({ ...base, ref: 'd'.repeat(40), upstreamVersion: 'oldtree' })).changed).toBe(true);
  });
});

describe('MCP registry connector', () => {
  const entry = (name: string, status = 'active') => ({ server: { name, description: 'd', version: '1.2.0', repository: { url: 'https://github.com/o/r' }, remotes: [{ type: 'streamable-http', url: 'https://x', headers: [{ isSecret: true }] }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status, updatedAt: '2026-10-01T00:00:00Z' } } });
  it('normalizes active entries, walks the registry by cursor and treats records as metadata only', async () => {
    const { impl, calls } = fakeFetch([[/\/v0\/servers/, () => ({ body: { servers: [entry('io.acme/files'), entry('io.gone/x', 'deleted')], metadata: { nextCursor: 'CUR' } } })]]);
    const c = createMcpRegistryConnector({ fetchImpl: impl });
    const r = await c.search({ mode: 'broad', limit: 10 });
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toMatchObject({ kind: 'mcp-server', externalId: 'io.acme/files', repo: 'o/r', upstreamVersion: '1.2.0', publisher: 'io.acme' });
    expect(r.drafts[0].signals).toMatchObject({ needsSecret: true, remotes: 1 });
    expect(r.cursor.next).toBe('CUR');
    await c.search({ mode: 'broad', limit: 10, cursor: r.cursor });
    expect(calls[1]).toMatch(/cursor=CUR/);
    const pkg = await c.fetchPackage({ externalId: 'io.acme/files', raw: r.drafts[0].raw });
    expect(pkg.files[0].path).toBe('server.json');
    expect(pkg.skipped[0].reason).toMatch(/not fetched or reviewed/);
  });
});

describe('local and policy-blocked sources', () => {
  it('indexes local Claude skills read-only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
    fs.mkdirSync(path.join(root, 'skills', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha skill\n---\nbody');
    const before = fs.readdirSync(path.join(root, 'skills', 'alpha'));
    const c = createLocalClaudeConnector({ claudeRoot: root });
    const r = await c.search({ mode: 'broad', limit: 10 });
    expect(r.drafts[0]).toMatchObject({ name: 'alpha', description: 'Alpha skill', kind: 'skill' });
    const pkg = await c.fetchPackage({ externalId: r.drafts[0].externalId });
    expect(pkg.files[0].path).toBe('SKILL.md');
    expect(pkg.provenance.verified).toBe(false);
    expect(fs.readdirSync(path.join(root, 'skills', 'alpha'))).toEqual(before);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never issues a request to a policy-blocked source', async () => {
    const c = createSkillsShConnector();
    expect((await c.health()).ok).toBe(false);
    await expect(c.search({ mode: 'broad', limit: 1 })).rejects.toThrow(/robots\.txt/);
  });

  it('registers all default sources through the composition root', () => {
    sys = tempSystem();
    const reg = buildConnectorRegistry(sys, { token: null });
    expect(reg.list().map((c) => c.id)).toEqual(['github', 'mcp-registry', 'local-claude', 'official-skills', 'curated-lists', 'npm', 'skills-sh', 'gitlab', 'pypi']);
    // every policy-blocked source states why, and the open ones that make their own HTTP requests declare their basis
    for (const id of ['skills-sh', 'gitlab', 'pypi']) expect(reg.get(id).terms).toMatchObject({ allowed: false, basis: expect.stringMatching(/robots\.txt/) });
    expect(reg.get('npm').terms).toMatchObject({ allowed: true });
  });
});

describe('npm registry source', () => {
  const pkg = (name: string, extra: Record<string, unknown> = {}) => ({ package: { name, version: '1.2.0', description: `${name} MCP server`, license: 'MIT', links: { npm: `https://www.npmjs.com/package/${name}`, repository: `git+https://github.com/acme/${name.replace('@acme/', '')}.git` }, publisher: { username: 'acme' }, keywords: ['mcp', 'mcp-server'], date: '2026-11-01T00:00:00Z', ...extra }, downloads: { monthly: 1200 }, dependents: '3' });

  it('turns search results into metadata-only MCP-server candidates and pages through broad scans', async () => {
    const { impl, calls } = fakeFetch([[/\/-\/v1\/search/, () => ({ body: { total: 3, objects: [pkg('@acme/weather'), pkg('files-mcp', { license: undefined })] } })]]);
    const npm = createNpmConnector({ fetchImpl: impl });
    const r = await npm.search({ mode: 'broad', limit: 2 });
    expect(r.requests).toBe(1);
    expect(r.drafts[0]).toMatchObject({ externalId: '@acme/weather', kind: 'mcp-server', repo: 'acme/weather', publisher: 'acme', licenseSpdx: 'MIT', upstreamVersion: '1.2.0', signals: { monthlyDownloads: 1200, dependents: 3 } });
    expect(r.drafts[1].licenseSpdx).toBeUndefined();
    expect(r.drafts[1].licenseEvidence).toMatch(/does not state a licence/);
    expect(r.cursor).toEqual({ from: 2 });
    expect(calls[0]).toContain('text=keywords%3Amcp-server');
    // need-driven scans search the query and do not move the broad cursor
    const need = await npm.search({ mode: 'need', query: 'weather', limit: 5, cursor: { from: 2 } });
    expect(need.cursor).toEqual({ from: 2 });
    expect(calls[1]).toContain('text=weather+keywords%3Amcp');
  });

  it('fetches only the manifest and README, never the package code, and detects new versions', async () => {
    const doc = { 'dist-tags': { latest: '1.3.0' }, readme: '# Weather\nUse it.', versions: { '1.2.0': { name: '@acme/weather', version: '1.2.0', license: 'MIT', bin: { weather: 'dist/index.js' }, dependencies: { zod: '^3' } } } };
    // the registry accepts the scoped name with the slash encoded (verified live 2026-11-12)
    const { impl, calls } = fakeFetch([[/registry\.npmjs\.org\/@acme%2Fweather$/, () => ({ body: doc })]]);
    const npm = createNpmConnector({ fetchImpl: impl });
    const p = await npm.fetchPackage({ externalId: '@acme/weather', raw: { name: '@acme/weather', version: '1.2.0' } });
    expect(p.files.map((f) => f.path)).toEqual(['package.json', 'README.md']);
    expect(JSON.parse(p.files[0].content)).toMatchObject({ name: '@acme/weather', bin: { weather: 'dist/index.js' } });
    expect(p.skipped[0].reason).toMatch(/metadata only/);
    expect(calls.every((u) => !/\.tgz/.test(u))).toBe(true);
    expect(await npm.checkUpdate!({ externalId: '@acme/weather', upstreamVersion: '1.2.0' })).toMatchObject({ changed: true, version: '1.3.0' });
  });
});

describe('repository-list sources', () => {
  it('extracts repository links from a list and ignores the list itself and non-repository pages', () => {
    const md = [
      '- [Weather](https://github.com/acme/weather-mcp) - forecasts',
      '- [Files](https://github.com/acme/files.git) and https://github.com/acme/files/tree/main/src',
      '- see https://github.com/topics/mcp and https://github.com/sponsors/someone',
      '- back to https://github.com/punkpeye/awesome-mcp-servers',
      '- trailing https://github.com/Acme/Notes.',
    ].join('\n');
    expect(repositoryLinks(md, 'punkpeye/awesome-mcp-servers')).toEqual(['acme/weather-mcp', 'acme/files', 'acme/notes']);
  });

  it('walks the list with a cursor across scans and delegates each repository to the GitHub source', async () => {
    const seen: string[] = [];
    const github = {
      ...createSkillsShConnector(),
      id: 'github',
      async health() {
        return { ok: true, authenticated: true, detail: 'ok' };
      },
      async search(req: { query?: string; limit: number }) {
        const repo = String(req.query).replace('repo:', '');
        seen.push(repo);
        return { drafts: [{ externalId: `${repo}:.#skill`, kind: 'skill' as const, name: repo, description: 'd', repo }], requests: 3 };
      },
    } as any;
    const list = createRepoListConnector({ id: 'list', title: 'List', description: 'd', official: true, github, repos: async () => ({ repos: ['a/one', 'a/two', 'a/three', 'A/One'], requests: 1, notes: [] }) });
    const first = await list.search({ mode: 'broad', limit: 2 });
    expect(first.drafts.map((d) => d.repo)).toEqual(['a/one', 'a/two']);
    expect(first.requests).toBe(7); // the list read plus three per repository
    const second = await list.search({ mode: 'broad', limit: 2, cursor: first.cursor });
    expect(second.drafts.map((d) => d.repo)).toEqual(['a/three', 'a/one']); // continues, wraps, and never repeats a duplicate entry
    const need = await list.search({ mode: 'need', query: 'three', limit: 5, cursor: second.cursor });
    expect(need.drafts.map((d) => d.repo)).toEqual(['a/three']);
    expect(need.cursor).toEqual(second.cursor);
    expect(seen).toEqual(['a/one', 'a/two', 'a/three', 'a/one', 'a/three']);
  });
});
