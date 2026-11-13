import { type CandidateDraft, type DiscoveryConnector, PRODUCT, type SearchRequest, type SearchResult } from '@synaptome/core';
import type { FetchLike } from './github-api';

const BASE = 'https://registry.npmjs.org';

/**
 * npm registry: packages that publish themselves as MCP servers. Metadata only (package.json fields and README
 * from the registry document); no tarball is downloaded, so every candidate is treated as unreviewed executable
 * code and needs a person's approval. registry.npmjs.org/robots.txt has no rules (checked 2026-11-12).
 */
export function createNpmConnector(opts: { fetchImpl?: FetchLike; base?: string } = {}): DiscoveryConnector {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.base ?? BASE;
  async function get<T>(pathAndQuery: string): Promise<T> {
    const res = await f(`${base}${pathAndQuery}`, { headers: { Accept: 'application/json', 'User-Agent': PRODUCT.userAgent } });
    if (res.status === 429) throw new Error('npm registry rate limit reached; try again later');
    if (!res.ok) throw new Error(`npm registry responded ${res.status}`);
    return JSON.parse(await res.text()) as T;
  }
  const repoOf = (url?: string) => /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '')?.[1];

  return {
    id: 'npm',
    kind: 'package-registry',
    title: 'npm registry (MCP servers)',
    description: 'Packages on npm that declare themselves MCP servers. Metadata only; package code is never downloaded at discovery time.',
    official: false,
    terms: { allowed: true, basis: 'registry.npmjs.org/robots.txt has no rules; documented public search API', checkedAt: '2026-11-12' },

    async health() {
      try {
        await get('/-/v1/search?text=keywords:mcp-server&size=1');
        return { ok: true, authenticated: false, detail: 'public search API reachable (no authentication required)' };
      } catch (e: any) {
        return { ok: false, authenticated: false, detail: e?.message ?? String(e) };
      }
    },

    async search(req: SearchRequest): Promise<SearchResult> {
      const cursor = { from: 0, ...(req.cursor ?? {}) } as { from: number };
      const text = req.query ? `${req.query} keywords:mcp` : 'keywords:mcp-server';
      const from = req.mode === 'broad' && !req.query ? cursor.from : 0;
      const size = Math.min(50, Math.max(1, req.limit));
      const r = await get<{ total: number; objects: any[] }>(`/-/v1/search?${new URLSearchParams({ text, size: String(size), from: String(from), ...(req.mode === 'incremental' ? { quality: '0', popularity: '0', maintenance: '1' } : {}) })}`);
      const drafts: CandidateDraft[] = r.objects.map((o) => {
        const p = o.package ?? {};
        const repo = repoOf(p.links?.repository);
        return {
          externalId: p.name,
          kind: 'mcp-server',
          name: p.name,
          description: p.description ?? '',
          url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
          repo,
          publisher: p.publisher?.username ?? (String(p.name).startsWith('@') ? String(p.name).split('/')[0].slice(1) : undefined),
          licenseSpdx: typeof p.license === 'string' ? p.license : undefined,
          licenseEvidence: typeof p.license === 'string' ? `npm package metadata: license "${p.license}"` : 'npm search result does not state a licence',
          upstreamVersion: p.version,
          pushedAt: p.date ?? o.updated,
          topics: ['mcp', 'npm', ...(p.keywords ?? []).slice(0, 10)],
          signals: { monthlyDownloads: o.downloads?.monthly ?? 0, dependents: Number(o.dependents ?? 0) },
          raw: { name: p.name, version: p.version },
        };
      });
      if (req.mode === 'broad' && !req.query) cursor.from = from + r.objects.length >= r.total ? 0 : from + r.objects.length;
      return { drafts, cursor: req.mode === 'broad' && !req.query ? cursor : req.cursor, notes: [`npm search "${text}": ${r.total} packages match, ${drafts.length} returned`], requests: 1 };
    },

    async fetchPackage(c) {
      const name = c.raw?.name ?? c.externalId;
      const doc = await get<any>(`/${encodeURIComponent(name).replace('%40', '@')}`);
      const version = c.raw?.version ?? doc['dist-tags']?.latest;
      const v = doc.versions?.[version] ?? {};
      const manifest = JSON.stringify({ name: v.name, version: v.version, description: v.description, license: v.license, bin: v.bin, main: v.main, scripts: v.scripts, dependencies: v.dependencies, repository: v.repository, engines: v.engines }, null, 2);
      const files = [{ path: 'package.json', content: manifest, size: Buffer.byteLength(manifest) }];
      if (typeof doc.readme === 'string' && doc.readme.trim()) files.push({ path: 'README.md', content: doc.readme, size: Buffer.byteLength(doc.readme) });
      return {
        files,
        skipped: [{ path: '(package tarball)', reason: 'metadata only: the package code was not downloaded or reviewed' }],
        provenance: { url: `${base}/${name}`, method: `npm registry document, version ${version}`, verified: true },
      };
    },

    async checkUpdate(c) {
      const doc = await get<any>(`/${encodeURIComponent(c.externalId).replace('%40', '@')}`);
      const latest = doc['dist-tags']?.latest;
      if (!latest) return { changed: false, detail: 'no latest version published' };
      return latest !== c.upstreamVersion ? { changed: true, version: latest, detail: `npm ${c.upstreamVersion} -> ${latest}` } : { changed: false, version: latest, detail: 'up to date' };
    },
  };
}

/** A source registered so its status is visible, but never queried because its robots.txt disallows the API. */
export function createBlockedConnector(o: { id: string; kind: string; title: string; description: string; basis: string; checkedAt: string }): DiscoveryConnector {
  const detail = `not queried: ${o.basis}`;
  return {
    id: o.id,
    kind: o.kind,
    title: o.title,
    description: o.description,
    official: false,
    terms: { allowed: false, basis: o.basis, checkedAt: o.checkedAt },
    async health() {
      return { ok: false, authenticated: false, detail };
    },
    async search() {
      throw new Error(detail);
    },
    async fetchPackage() {
      throw new Error(detail);
    },
  };
}
