import { type CandidateDraft, type DiscoveryConnector, type FetchedFile, type FetchedPackage, type SearchRequest, type SearchResult, parseFrontmatter } from '@synaptome/core';
import { BINARY_EXT, GitHubClient, type GitHubClientOptions, GitHubNotFound, GitHubRateLimit, type Unit, detectUnits } from './github-api';

/**
 * Targeted search strategy. Broad scans walk this list a few entries at a time (cursor.broadIndex),
 * so the whole list is covered across runs without exhausting the 30 searches/minute budget.
 * Extend this list to widen coverage; nothing else needs to change.
 */
export const BROAD_QUERIES = [
  'topic:agent-skills',
  'topic:claude-skills',
  'topic:claude-code-skills',
  'topic:claude-code-plugin',
  'topic:claude-code-subagents',
  'topic:claude-code-agents',
  'topic:mcp-server stars:>300',
  'topic:codex-skills',
  'topic:gemini-cli-extension',
  'topic:cursor-rules stars:>200',
  'SKILL.md agent skills in:readme stars:>50',
  'org:anthropics skills',
  'org:modelcontextprotocol servers',
];
const QUERIES_PER_BROAD_SCAN = 3;
const REPOS_PER_QUERY = 4;
const UNITS_PER_REPO = 10;
const MAX_FILES = 80;
const MAX_FILE_BYTES = 256 * 1024;

interface RepoLite {
  full_name: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  pushed_at: string;
  topics?: string[];
  archived: boolean;
  fork: boolean;
  license: { spdx_id: string | null } | null;
  owner: { login: string };
  html_url: string;
}

export function createGitHubConnector(opts: GitHubClientOptions = {}): DiscoveryConnector & { client: GitHubClient } {
  const gh = new GitHubClient(opts);

  async function expandRepo(repo: RepoLite, budget: number, notes: string[]): Promise<CandidateDraft[]> {
    if (repo.archived) {
      notes.push(`${repo.full_name}: skipped (archived)`);
      return [];
    }
    const commit = String(await gh.get<string>(`/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`, { accept: 'application/vnd.github.sha' })).trim();
    const tree = await gh.get<{ sha: string; truncated: boolean; tree: { path: string; type: string; sha: string; size?: number }[] }>(`/repos/${repo.full_name}/git/trees/${commit}?recursive=1`);
    const bySha = new Map(tree.tree.map((t) => [t.path, t.sha]));
    let units = detectUnits(tree.tree.filter((t) => t.type === 'blob').map((t) => t.path));
    if (!units.length) units = [{ kind: (repo.topics ?? []).some((t) => /mcp/.test(t)) ? 'mcp-server' : 'tool', path: '', entry: 'README.md', isDir: true }];
    if (units.length > Math.min(UNITS_PER_REPO, budget)) {
      notes.push(`${repo.full_name}: ${units.length} units detected, kept the first ${Math.min(UNITS_PER_REPO, budget)} this scan`);
      units = units.slice(0, Math.min(UNITS_PER_REPO, budget));
    }
    if (tree.truncated) notes.push(`${repo.full_name}: tree listing truncated by GitHub; some units may be missing`);
    const spdx = repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : undefined;
    const drafts: CandidateDraft[] = [];
    for (const u of units) {
      let name = u.path ? u.path.slice(u.path.lastIndexOf('/') + 1).replace(/\.(md|ya?ml)$/, '') : repo.full_name.split('/')[1];
      let description = u.path === '' ? repo.description ?? '' : '';
      if ((u.kind === 'skill' || u.kind === 'agent' || u.kind === 'prompt') && bySha.has(u.entry)) {
        try {
          const md = await gh.get<string>(`/repos/${repo.full_name}/git/blobs/${bySha.get(u.entry)}`, { accept: 'application/vnd.github.raw+json' });
          const fm = parseFrontmatter(String(md)).data;
          if (typeof fm.name === 'string' && fm.name) name = fm.name;
          if (typeof fm.description === 'string' && fm.description) description = fm.description;
        } catch (e) {
          if (e instanceof GitHubRateLimit) throw e;
        }
      }
      drafts.push({
        externalId: `${repo.full_name}:${u.path || '.'}#${u.kind}`,
        kind: u.kind,
        name,
        description: description || repo.description || '',
        url: `${repo.html_url}/tree/${commit}/${u.path}`,
        repo: repo.full_name,
        ref: commit,
        path: u.path,
        publisher: repo.owner.login,
        licenseSpdx: spdx,
        licenseEvidence: spdx ? `GitHub licence detection for ${repo.full_name}: ${spdx}` : `GitHub reports no recognised licence for ${repo.full_name}`,
        stars: repo.stargazers_count,
        pushedAt: repo.pushed_at,
        topics: repo.topics ?? [],
        upstreamVersion: u.path ? bySha.get(u.path) ?? bySha.get(u.entry) : tree.sha,
        signals: { fork: repo.fork, unitsInRepo: units.length, isDir: u.isDir },
        raw: { defaultBranch: repo.default_branch, entry: u.entry, isDir: u.isDir },
      });
    }
    return drafts;
  }

  return {
    id: 'github',
    kind: 'code-host',
    title: 'GitHub',
    description: 'Targeted repository discovery: topics, organisations, README signals; detects skills, agents, plugins, hooks, prompts, workflows and MCP servers inside each repository.',
    official: false,
    client: gh,

    async health() {
      try {
        const r = await gh.get<any>('/rate_limit');
        const s = r.resources.search;
        gh.rate.search = { limit: s.limit, remaining: s.remaining, resetAt: new Date(s.reset * 1000).toISOString() };
        gh.rate.core = { limit: r.resources.core.limit, remaining: r.resources.core.remaining, resetAt: new Date(r.resources.core.reset * 1000).toISOString() };
        return { ok: true, authenticated: gh.authenticated, detail: `${gh.authenticated ? 'authenticated' : 'unauthenticated'}; core ${r.resources.core.remaining}/${r.resources.core.limit}, search ${s.remaining}/${s.limit} per minute`, rate: gh.rate.search };
      } catch (e: any) {
        return { ok: false, authenticated: gh.authenticated, detail: e?.message ?? String(e) };
      }
    },

    async search(req: SearchRequest): Promise<SearchResult> {
      const callsAtStart = gh.calls;
      const hitsAtStart = gh.cacheHits;
      const notes: string[] = [];
      const drafts: CandidateDraft[] = [];
      const cursor = { broadIndex: 0, lastIncremental: '', ...(req.cursor ?? {}) };
      const seen = new Set<string>();
      let stoppedEarly: string | undefined;
      let queries: string[];
      const direct = /^repo:([\w.-]+\/[\w.-]+)$/.exec(req.query?.trim() ?? '');
      if (direct) queries = [];
      else if (req.mode === 'need' && req.query) queries = [`${req.query} skill in:name,description,topics,readme`, `${req.query} in:name,description topic:mcp-server`];
      else if (req.mode === 'incremental') {
        const since = cursor.lastIncremental || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
        queries = ['topic:agent-skills', 'topic:claude-skills', 'topic:claude-code-plugin'].map((q) => `${q} pushed:>${since}`);
      } else {
        queries = Array.from({ length: QUERIES_PER_BROAD_SCAN }, (_, i) => BROAD_QUERIES[(cursor.broadIndex + i) % BROAD_QUERIES.length]);
        if (req.query) queries = [`${req.query} in:name,description,topics`, ...queries.slice(0, 1)];
        cursor.broadIndex = (cursor.broadIndex + QUERIES_PER_BROAD_SCAN) % BROAD_QUERIES.length;
      }
      try {
        if (direct) {
          const repo = await gh.get<RepoLite>(`/repos/${direct[1]}`);
          drafts.push(...(await expandRepo(repo, req.limit, notes)));
        }
        for (const q of queries) {
          if (drafts.length >= req.limit) break;
          const res = await gh.get<{ total_count: number; items: RepoLite[] }>(`/search/repositories?q=${encodeURIComponent(q)}&sort=${req.mode === 'incremental' ? 'updated' : 'stars'}&order=desc&per_page=${REPOS_PER_QUERY + 2}`, { resource: 'search' });
          notes.push(`query "${q}": ${res.total_count} repositories match, inspected up to ${REPOS_PER_QUERY}`);
          let taken = 0;
          for (const repo of res.items) {
            if (taken >= REPOS_PER_QUERY || drafts.length >= req.limit) break;
            if (seen.has(repo.full_name) || repo.fork) continue;
            seen.add(repo.full_name);
            taken++;
            try {
              drafts.push(...(await expandRepo(repo, req.limit - drafts.length, notes)));
            } catch (e) {
              if (e instanceof GitHubRateLimit) throw e;
              notes.push(`${repo.full_name}: ${e instanceof GitHubNotFound ? 'not accessible' : (e as Error).message}`);
            }
          }
        }
      } catch (e) {
        if (!(e instanceof GitHubRateLimit)) throw e;
        notes.push(`stopped early: ${e.message}. Partial results kept.`);
        stoppedEarly = `${e.message}${gh.authenticated ? '' : ' (unauthenticated: 60 requests an hour; set GITHUB_TOKEN or sign in with gh for 5,000)'}`;
      }
      if (req.mode === 'incremental' && !stoppedEarly) cursor.lastIncremental = new Date().toISOString().slice(0, 10);
      const requests = gh.calls - callsAtStart;
      notes.push(`GitHub API calls this scan: ${requests} (${gh.cacheHits - hitsAtStart} served from ETag cache)`);
      // Conditional requests answered from the ETag cache are still HTTP requests, so they count.
      return { drafts: drafts.slice(0, req.limit), cursor, rate: gh.rate.search, notes, requests, stoppedEarly };
    },

    async fetchPackage(c): Promise<FetchedPackage> {
      if (!c.repo || !c.ref) throw new Error('GitHub candidate is missing repo or pinned commit');
      const isDir = c.raw?.isDir !== false;
      const prefix = c.path ? (isDir ? `${c.path}/` : c.path) : '';
      const tree = await gh.get<{ tree: { path: string; type: string; sha: string; size?: number }[]; truncated: boolean }>(`/repos/${c.repo}/git/trees/${c.ref}?recursive=1`);
      const blobs = tree.tree.filter((t) => t.type === 'blob' && (isDir ? t.path.startsWith(prefix) : t.path === prefix) && !/(^|\/)(node_modules|\.git)\//.test(t.path));
      const files: FetchedFile[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const b of blobs) {
        const rel = isDir ? b.path.slice(prefix.length) : b.path.slice(b.path.lastIndexOf('/') + 1);
        if (files.length >= MAX_FILES) {
          skipped.push({ path: rel, reason: `file limit (${MAX_FILES}) reached` });
          continue;
        }
        if (BINARY_EXT.test(rel)) {
          skipped.push({ path: rel, reason: 'binary file not fetched' });
          continue;
        }
        if ((b.size ?? 0) > MAX_FILE_BYTES) {
          skipped.push({ path: rel, reason: `larger than ${MAX_FILE_BYTES} bytes` });
          continue;
        }
        const content = String(await gh.get<string>(`/repos/${c.repo}/git/blobs/${b.sha}`, { accept: 'application/vnd.github.raw+json' }));
        if (content.includes('\u0000')) {
          skipped.push({ path: rel, reason: 'binary content' });
          continue;
        }
        files.push({ path: rel, content, size: Buffer.byteLength(content) });
      }
      if (tree.truncated) skipped.push({ path: '(tree)', reason: 'GitHub truncated the tree listing' });
      let license: FetchedPackage['license'];
      try {
        const lic = await gh.get<any>(`/repos/${c.repo}/license?ref=${c.ref}`);
        const text = Buffer.from(lic.content ?? '', 'base64').toString('utf8');
        license = { spdx: lic.license?.spdx_id && lic.license.spdx_id !== 'NOASSERTION' ? lic.license.spdx_id : undefined, evidence: `${lic.path} in ${c.repo}@${String(c.ref).slice(0, 7)}: "${text.split(/\r?\n/).find((l: string) => l.trim())?.trim().slice(0, 120) ?? ''}"` };
        if (!files.some((f) => /^licen[cs]e/i.test(f.path))) files.push({ path: `.upstream/${lic.path}`, content: text, size: Buffer.byteLength(text) });
      } catch (e) {
        if (e instanceof GitHubRateLimit) throw e;
        license = { evidence: `no licence file found in ${c.repo}` };
      }
      return { files, ref: c.ref, license, skipped, provenance: { url: `https://github.com/${c.repo}/tree/${c.ref}/${c.path ?? ''}`, method: 'github-api: git tree and blobs at pinned commit', verified: /^[0-9a-f]{40}$/.test(c.ref) } };
    },

    async checkUpdate(c) {
      if (!c.repo) return { changed: false, detail: 'no repository' };
      // The API follows a transferred repository silently; its current full name reveals a new owner.
      let who: { publisher?: string; repo?: string } = {};
      try {
        const meta = await gh.get<{ full_name?: string; owner?: { login?: string } }>(`/repos/${c.repo}`);
        who = { publisher: meta?.owner?.login, repo: meta?.full_name };
      } catch {
        /* owner unknown this time; the content check below still runs */
      }
      const branch = c.raw?.defaultBranch ?? 'HEAD';
      const commit = String(await gh.get<string>(`/repos/${c.repo}/commits/${encodeURIComponent(branch)}`, { accept: 'application/vnd.github.sha' })).trim();
      if (commit === c.ref) return { changed: false, ref: commit, detail: 'repository head unchanged', ...who };
      const tree = await gh.get<{ sha: string; tree: { path: string; sha: string }[] }>(`/repos/${c.repo}/git/trees/${commit}?recursive=1`);
      const cur = c.path ? tree.tree.find((t) => t.path === c.path)?.sha : tree.sha;
      if (!cur) return { changed: true, ref: commit, detail: 'path no longer exists upstream', ...who };
      return cur === c.upstreamVersion ? { changed: false, ref: commit, version: cur, detail: 'repository moved but this unit is unchanged', ...who } : { changed: true, ref: commit, version: cur, detail: `content changed upstream (${String(c.ref).slice(0, 7)} -> ${commit.slice(0, 7)})`, ...who };
    },
  };
}

export type { Unit };
