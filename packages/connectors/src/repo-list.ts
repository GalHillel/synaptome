import type { DiscoveryConnector, SearchRequest, SearchResult } from '@synaptome/core';

/**
 * A source that is a list of GitHub repositories: official skill repositories, or repositories linked from curated
 * lists. It walks the list with a stored cursor and expands each repository through the GitHub connector, so
 * fetching, auditing and update checks behave exactly as for any GitHub candidate.
 */
export function createRepoListConnector(o: {
  id: string;
  title: string;
  description: string;
  official: boolean;
  github: DiscoveryConnector;
  /** The repositories to walk, as owner/name. Called once per scan. */
  repos: () => Promise<{ repos: string[]; requests: number; notes: string[] }>;
}): DiscoveryConnector {
  return {
    id: o.id,
    kind: 'repo-list',
    title: o.title,
    description: o.description,
    official: o.official,
    health: () => o.github.health(),

    async search(req: SearchRequest): Promise<SearchResult> {
      const listed = await o.repos();
      const notes = [...listed.notes];
      let requests = listed.requests;
      const all = [...new Set(listed.repos.map((r) => r.toLowerCase()))];
      if (!all.length) return { drafts: [], cursor: req.cursor, notes: [...notes, 'the list is empty'], requests };
      const q = req.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const repos = req.mode === 'need' && q.length ? all.filter((r) => q.some((w) => r.includes(w))) : all;
      const cursor = { index: 0, ...(req.cursor ?? {}) } as { index: number };
      const start = req.mode === 'need' ? 0 : cursor.index % Math.max(1, repos.length);
      const drafts: SearchResult['drafts'] = [];
      let stoppedEarly: string | undefined;
      let visited = 0;
      for (let i = 0; i < repos.length && drafts.length < req.limit; i++) {
        const repo = repos[(start + i) % repos.length];
        visited++;
        try {
          const r = await o.github.search({ mode: 'broad', query: `repo:${repo}`, limit: req.limit - drafts.length });
          requests += r.requests ?? 0;
          drafts.push(...r.drafts);
          if (r.stoppedEarly) {
            notes.push(`stopped at ${repo}: ${r.stoppedEarly}`);
            stoppedEarly = r.stoppedEarly;
            break;
          }
        } catch (e) {
          notes.push(`${repo}: ${(e as Error).message}`);
        }
      }
      if (req.mode !== 'need' && repos.length) cursor.index = (start + visited) % repos.length;
      notes.push(`${visited} of ${repos.length} listed repositories visited this scan${req.mode !== 'need' ? '; the walk continues on the next scan' : ''}`);
      return { drafts, cursor: req.mode === 'need' ? req.cursor : cursor, notes, requests, stoppedEarly };
    },

    fetchPackage: (c) => o.github.fetchPackage(c),
    checkUpdate: o.github.checkUpdate ? (c) => o.github.checkUpdate!(c) : undefined,
  };
}

/** github.com/owner/name links in a Markdown document, excluding the list's own repository and non-repository paths. */
export function repositoryLinks(markdown: string, self?: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g;
  const skipOwners = new Set(['topics', 'sponsors', 'orgs', 'features', 'marketplace', 'settings', 'apps', 'collections', 'about', 'pricing', 'login', 'search', 'notifications', 'user-attachments']);
  for (const m of markdown.matchAll(re)) {
    const owner = m[1];
    const name = m[2].replace(/\.git$/, '').replace(/[.]+$/, '');
    if (!name || skipOwners.has(owner.toLowerCase())) continue;
    const full = `${owner}/${name}`.toLowerCase();
    if (self && full === self.toLowerCase()) continue;
    out.add(full);
  }
  return [...out];
}

export const OFFICIAL_SKILL_REPOS = ['anthropics/skills', 'anthropics/claude-plugins-official', 'openai/skills', 'vercel-labs/agent-skills', 'github/awesome-copilot', 'modelcontextprotocol/servers', 'microsoft/skills'];
