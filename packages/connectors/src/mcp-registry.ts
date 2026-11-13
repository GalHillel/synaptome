import type { CandidateDraft, DiscoveryConnector, SearchRequest, SearchResult } from '@synaptome/core';
import { PRODUCT } from '@synaptome/core';
import type { FetchLike } from './github-api';

const BASE = 'https://registry.modelcontextprotocol.io';
const META = 'io.modelcontextprotocol.registry/official';

/** Official MCP registry (documented public REST API, cursor-paginated). Lists metadata, not source code. */
export function createMcpRegistryConnector(opts: { fetchImpl?: FetchLike; base?: string } = {}): DiscoveryConnector {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.base ?? BASE;
  async function get(pathAndQuery: string) {
    const res = await f(`${base}${pathAndQuery}`, { headers: { Accept: 'application/json', 'User-Agent': PRODUCT.userAgent } });
    if (res.status === 429) throw new Error('MCP registry rate limit reached; try again later');
    if (!res.ok) throw new Error(`MCP registry responded ${res.status}`);
    return JSON.parse(await res.text()) as { servers: any[]; metadata?: { nextCursor?: string; count?: number } };
  }
  const toDraft = (entry: any): CandidateDraft | null => {
    const s = entry.server ?? entry;
    const meta = entry._meta?.[META] ?? {};
    if (!s?.name || (meta.status && meta.status !== 'active')) return null;
    const repoUrl: string = s.repository?.url ?? '';
    const gh = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repoUrl);
    const packages: any[] = s.packages ?? [];
    const remotes: any[] = s.remotes ?? [];
    const needsSecret = JSON.stringify([packages, remotes]).includes('"isSecret":true');
    return {
      externalId: s.name,
      kind: 'mcp-server',
      name: s.title || s.name,
      description: s.description ?? '',
      url: repoUrl || s.websiteUrl || `${base}/v0/servers?search=${encodeURIComponent(s.name)}`,
      repo: gh?.[1],
      publisher: String(s.name).split('/')[0],
      upstreamVersion: s.version,
      pushedAt: meta.updatedAt ?? meta.publishedAt,
      topics: ['mcp', ...packages.map((p) => String(p.registryType ?? p.registry_type ?? '')).filter(Boolean)],
      signals: { remotes: remotes.length, packages: packages.length, transport: [...new Set([...remotes.map((r) => r.type), ...packages.map((p) => p.transport?.type)])].filter(Boolean).join(','), needsSecret },
      raw: { server: s },
    };
  };

  return {
    id: 'mcp-registry',
    kind: 'registry',
    title: 'Official MCP Registry',
    description: 'registry.modelcontextprotocol.io — server metadata published by maintainers. Implementation code is not hosted here, so every entry is treated as executable and needs approval.',
    official: true,

    async health() {
      try {
        const r = await get('/v0/servers?limit=1');
        return { ok: Array.isArray(r.servers), authenticated: false, detail: 'public API reachable (no authentication required)' };
      } catch (e: any) {
        return { ok: false, authenticated: false, detail: e?.message ?? String(e) };
      }
    },

    async search(req: SearchRequest): Promise<SearchResult> {
      const cursor = { next: '', lastIncremental: '', ...(req.cursor ?? {}) };
      const notes: string[] = [];
      const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, req.limit))), version: 'latest' });
      if (req.query) params.set('search', req.query);
      else if (req.mode === 'incremental') params.set('updated_since', cursor.lastIncremental || new Date(Date.now() - 7 * 864e5).toISOString());
      else if (cursor.next) params.set('cursor', cursor.next);
      const r = await get(`/v0/servers?${params}`);
      const drafts = r.servers.map(toDraft).filter((d): d is CandidateDraft => !!d);
      if (req.mode === 'broad' && !req.query) {
        cursor.next = r.metadata?.nextCursor ?? '';
        notes.push(cursor.next ? 'registry walk continues from the stored cursor on the next broad scan' : 'reached the end of the registry; next broad scan restarts');
      }
      if (req.mode === 'incremental') cursor.lastIncremental = new Date().toISOString();
      notes.push(`${r.servers.length} entries returned, ${drafts.length} active latest versions kept`);
      return { drafts, cursor, notes, requests: 1 };
    },

    async fetchPackage(c) {
      const server = c.raw?.server;
      if (!server) throw new Error('MCP registry candidate has no stored server record');
      const content = JSON.stringify(server, null, 2);
      return {
        files: [{ path: 'server.json', content, size: Buffer.byteLength(content) }],
        skipped: [{ path: '(server implementation)', reason: 'the registry lists metadata only; implementation source was not fetched or reviewed' }],
        provenance: { url: `${base}/v0/servers?search=${encodeURIComponent(c.externalId)}`, method: 'mcp-registry-api: published server record', verified: true },
      };
    },

    async checkUpdate(c) {
      const r = await get(`/v0/servers?${new URLSearchParams({ search: c.externalId, version: 'latest', limit: '20' })}`);
      const hit = r.servers.map((e) => e.server ?? e).find((s) => s.name === c.externalId);
      if (!hit) return { changed: false, detail: 'entry no longer listed' };
      return hit.version !== c.upstreamVersion ? { changed: true, version: hit.version, detail: `registry version ${c.upstreamVersion} -> ${hit.version}` } : { changed: false, version: hit.version, detail: 'up to date' };
    },
  };
}
