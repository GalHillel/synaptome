import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Kind, PRODUCT, type RateState, sha256 } from '@synaptome/core';

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class GitHubRateLimit extends Error {
  constructor(public resource: string, public resetAt?: string) {
    super(`GitHub ${resource} rate limit reached${resetAt ? `; resets at ${resetAt}` : ''}`);
  }
}
export class GitHubNotFound extends Error {}

/** Token is read at call time from the environment or the gh CLI. It is never written to disk or logs. */
export function resolveGitHubToken(): string | null {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 8000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

export interface GitHubClientOptions {
  token?: string | null;
  fetchImpl?: FetchLike;
  cacheDir?: string;
  /** Stop issuing search calls when this many remain (keeps headroom for interactive use). */
  searchFloor?: number;
}

export class GitHubClient {
  rate: Record<string, RateState> = {};
  calls = 0;
  cacheHits = 0;
  private token: string | null | undefined;
  private fetchImpl: FetchLike;
  constructor(private opts: GitHubClientOptions = {}) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }
  get authenticated() {
    if (this.token === undefined) this.token = resolveGitHubToken();
    return !!this.token;
  }

  async get<T = any>(p: string, o: { accept?: string; resource?: 'core' | 'search' } = {}): Promise<T> {
    const url = p.startsWith('http') ? p : `https://api.github.com${p}`;
    const resource = o.resource ?? 'core';
    const r = this.rate[resource];
    if (r?.remaining !== undefined && r.remaining <= (resource === 'search' ? this.opts.searchFloor ?? 1 : 5)) {
      if (!r.resetAt || Date.parse(r.resetAt) > Date.now()) throw new GitHubRateLimit(resource, r.resetAt);
    }
    const accept = o.accept ?? 'application/vnd.github+json';
    const headers: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': PRODUCT.userAgent };
    if (this.authenticated) headers.Authorization = `Bearer ${this.token}`;
    const cacheFile = this.opts.cacheDir ? path.join(this.opts.cacheDir, `${sha256(`${url}\n${accept}`).slice(0, 32)}.json`) : null;
    let cached: { etag: string; body: string } | null = null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      try {
        cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
      } catch {
        cached = null;
      }
    }
    this.calls++;
    const res = await this.fetchImpl(url, { headers });
    const h = (n: string) => res.headers.get(n);
    const res_ = h('x-ratelimit-resource') ?? resource;
    if (h('x-ratelimit-remaining') !== null) {
      this.rate[res_] = { limit: Number(h('x-ratelimit-limit')), remaining: Number(h('x-ratelimit-remaining')), resetAt: h('x-ratelimit-reset') ? new Date(Number(h('x-ratelimit-reset')) * 1000).toISOString() : undefined };
    }
    let body: string;
    if (res.status === 304 && cached) {
      this.cacheHits++;
      body = cached.body;
    } else {
      body = await res.text();
      if (res.status === 404) throw new GitHubNotFound(`GitHub 404: ${url}`);
      if ((res.status === 403 || res.status === 429) && (h('x-ratelimit-remaining') === '0' || h('retry-after'))) throw new GitHubRateLimit(res_, this.rate[res_]?.resetAt);
      if (!res.ok) throw new Error(`GitHub ${res.status} for ${url.replace(/\?.*/, '')}: ${safeMessage(body)}`);
      const etag = h('etag');
      if (cacheFile && etag) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ etag, body }));
      }
    }
    if (accept.includes('raw') || accept.includes('.sha')) return body as unknown as T;
    return JSON.parse(body) as T;
  }
}

const safeMessage = (body: string) => {
  try {
    return String(JSON.parse(body).message ?? '').slice(0, 200);
  } catch {
    return body.slice(0, 120);
  }
};

/* ---------- capability unit detection from a repository tree (pure) ---------- */

export interface Unit {
  kind: Kind;
  /** Directory ('' = repo root) or single file path. */
  path: string;
  entry: string;
  isDir: boolean;
}

export function detectUnits(paths: string[]): Unit[] {
  const units = new Map<string, Unit>();
  const add = (u: Unit) => {
    const k = `${u.kind}:${u.path}`;
    if (!units.has(k)) units.set(k, u);
  };
  const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  for (const p of paths) {
    if (/(^|\/)node_modules\//.test(p) || /(^|\/)(test|tests|fixtures|__tests__|examples?\/broken)\//i.test(p)) continue;
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (base === 'SKILL.md') add({ kind: 'skill', path: dir(p), entry: p, isDir: true });
    else if (/(^|\/)\.claude-plugin\/plugin\.json$/.test(p)) add({ kind: 'plugin', path: dir(dir(p)), entry: p, isDir: true });
    else if (/(^|\/)agents\/[^/]+\.md$/.test(p) && !/^readme\.md$/i.test(base)) add({ kind: 'agent', path: p, entry: p, isDir: false });
    else if (/(^|\/)commands\/[^/]+\.md$/.test(p) && !/^readme\.md$/i.test(base)) add({ kind: 'prompt', path: p, entry: p, isDir: false });
    else if (/(^|\/)workflows\/[^/]+\.(md|ya?ml)$/.test(p) && !p.includes('.github/')) add({ kind: 'workflow', path: p, entry: p, isDir: false });
    else if (/(^|\/)hooks\/hooks\.json$/.test(p)) add({ kind: 'hook', path: dir(p), entry: p, isDir: true });
    else if (/(^|\/)server\.json$/.test(p) && p.split('/').length <= 2) add({ kind: 'mcp-server', path: dir(p), entry: p, isDir: true });
  }
  return [...units.values()];
}

export const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|tar|7z|rar|woff2?|ttf|otf|eot|mp[34]|mov|wav|ogg|exe|dll|so|dylib|bin|wasm|class|jar|pyc|node|db|sqlite)$/i;
