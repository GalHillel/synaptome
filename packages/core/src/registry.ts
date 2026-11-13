import fs from 'node:fs';
import path from 'node:path';
import { type Sys, emit, j, nowIso, pj, sha256, slug } from './db';
import { PRODUCT } from './identity';
import { LifecycleError, canTransition, recordTransition, transitionCapability } from './lifecycle';
import { CapabilityRecord, type CapabilityProvider, type CapabilityStatus, type FetchedFile } from './schema';

/* ---------- text helpers shared with the router ---------- */

export const STOPWORDS = new Set(
  'a an and are as at be but by can do for from has have how i if in into is it its me my need needs of on or our should so some that the their them then there these this to up us use using want we what when which who will with would you your please make create build add write help new get set also just very via per about across after before during'.split(
    ' ',
  ),
);
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^[.]+|[.]+$/g, '');
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}
export function ftsQuery(text: string): string {
  return tokenize(text)
    .map((t) => `"${t.replace(/"/g, '')}"*`)
    .join(' OR ');
}

/* ---------- immutable snapshot store ---------- */

export function safeRel(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((s) => s === '..' || s === '')) throw new Error(`Unsafe path in package: ${p}`);
  return n;
}
export function hashFiles(files: FetchedFile[]): string {
  const lines = files
    .map((f) => `${safeRel(f.path)}\0${sha256(f.content)}`)
    .sort()
    .join('\n');
  return sha256(lines);
}
/** Whitespace/case-insensitive hash used for near-duplicate detection. */
export function normalizedHash(files: FetchedFile[]): string {
  const text = files
    .filter((f) => /\.(md|mdx|txt|json|ya?ml|toml)$/i.test(f.path))
    .map((f) => f.content.toLowerCase().replace(/\s+/g, ' ').trim())
    .sort()
    .join('\n');
  return sha256(text);
}
export function writeTree(dir: string, files: FetchedFile[]) {
  for (const f of files) {
    const dest = path.join(dir, safeRel(f.path));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content, 'utf8');
  }
}
export function readTree(dir: string): FetchedFile[] {
  const out: FetchedFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name !== PRODUCT.manifestFile) {
        const content = fs.readFileSync(full, 'utf8');
        out.push({ path: path.relative(dir, full).replace(/\\/g, '/'), content, size: Buffer.byteLength(content) });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Writes a snapshot once; an existing snapshot with the same hash is never rewritten. */
export function writeSnapshot(sys: Sys, capabilityId: string, files: FetchedFile[]): { contentHash: string; snapshotPath: string } {
  const contentHash = hashFiles(files);
  const snapshotPath = path.join(sys.paths.store, slug(capabilityId), contentHash.slice(0, 16));
  if (!fs.existsSync(path.join(snapshotPath, PRODUCT.manifestFile))) {
    writeTree(snapshotPath, files);
    fs.writeFileSync(
      path.join(snapshotPath, PRODUCT.manifestFile),
      JSON.stringify({ capabilityId, contentHash, createdAt: nowIso(), files: files.map((f) => ({ path: safeRel(f.path), sha256: sha256(f.content), size: f.size })) }, null, 2),
    );
  }
  return { contentHash, snapshotPath };
}

/** CapabilityProvider backed by the snapshot store; verifies integrity on every read. */
export function snapshotProvider(sys: Sys): CapabilityProvider {
  return {
    id: 'snapshot-store',
    read(capabilityId) {
      const row = sys.db.get<{ snapshot_path: string; content_hash: string }>('SELECT snapshot_path, content_hash FROM capabilities WHERE id=?', capabilityId);
      if (!row?.snapshot_path || !fs.existsSync(row.snapshot_path)) return null;
      const files = readTree(row.snapshot_path);
      const contentHash = hashFiles(files);
      if (contentHash !== row.content_hash) throw new Error(`Snapshot integrity failure for ${capabilityId}: expected ${row.content_hash.slice(0, 12)}, found ${contentHash.slice(0, 12)}`);
      return { files, contentHash };
    },
  };
}

/* ---------- capabilities ---------- */

export interface CapabilityRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  domain: string;
  category: string;
  tags: string[];
  publisher: string;
  origin: string;
  status: CapabilityStatus;
  trust: string;
  tier: string;
  quality: number | null;
  contextCost: number;
  version: string | null;
  contentHash: string | null;
  snapshotPath: string | null;
  candidateId: string | null;
  record: CapabilityRecord;
  createdAt: string;
  updatedAt: string;
  installedHosts: string[];
  score?: number;
}

const INSTALLED_SQL = `(SELECT group_concat(host || ':' || scope) FROM installations i WHERE i.capability_id = c.id AND i.status = 'installed')`;

function mapCap(r: any): CapabilityRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    domain: r.domain ?? 'general',
    category: r.category ?? '',
    tags: pj(r.tags, []),
    publisher: r.publisher ?? '',
    origin: r.origin,
    status: r.status,
    trust: r.trust,
    tier: r.tier,
    quality: r.quality,
    contextCost: r.context_cost ?? 0,
    version: r.version,
    contentHash: r.content_hash,
    snapshotPath: r.snapshot_path,
    candidateId: r.candidate_id,
    record: pj(r.record, {} as CapabilityRecord),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    installedHosts: r.installed ? String(r.installed).split(',') : [],
    score: r.score,
  };
}

export interface UpsertExtras {
  status?: CapabilityStatus;
  origin?: string;
  candidateId?: string | null;
  snapshotPath?: string | null;
  contentHash?: string | null;
  version?: string | null;
  /** Searchable body text (entry file content); never served from the index. */
  body?: string;
  /** Why the status is set or changed; recorded in the lifecycle history. */
  reason?: string;
  /** Who set it (cli, web, policy, forge, …). */
  by?: string;
}

/** Words indexed with a capability's tags: its tags, domain, kind, supported tasks and its own trigger statements. */
const ftsTags = (rec: CapabilityRecord) => [...rec.tags, rec.domain, rec.category, rec.kind, ...rec.supportedTasks, ...rec.activation.filter((l) => !/^\s*(requires|never)\s*:/i.test(l))].join(' ');

export function upsertCapability(sys: Sys, input: unknown, extras: UpsertExtras = {}): CapabilityRow {
  const rec = CapabilityRecord.parse(input);
  const now = nowIso();
  const existing = sys.db.get<any>('SELECT * FROM capabilities WHERE id=?', rec.id);
  // A status change through an upsert obeys the same lifecycle as any other.
  if (existing && extras.status && extras.status !== existing.status && !canTransition(existing.status, extras.status)) {
    throw new LifecycleError(`${rec.id} cannot go from ${existing.status} to ${extras.status}`, 'not-allowed');
  }
  sys.db.tx(() => {
    if (existing) {
      sys.db.run(
        `UPDATE capabilities SET schema_version=?, name=?, description=?, kind=?, domain=?, category=?, tags=?, publisher=?, origin=?, status=?, trust=?, tier=?,
         quality=?, context_cost=?, version=?, content_hash=?, snapshot_path=?, candidate_id=?, record=?, updated_at=? WHERE id=?`,
        rec.schemaVersion, rec.name, rec.description, rec.kind, rec.domain, rec.category, j(rec.tags), rec.publisher,
        extras.origin ?? existing.origin, extras.status ?? existing.status, rec.security.trust, rec.security.tier, rec.quality.total, rec.contextCost,
        extras.version ?? existing.version, extras.contentHash ?? existing.content_hash, extras.snapshotPath ?? existing.snapshot_path,
        extras.candidateId ?? existing.candidate_id, j(rec), now, rec.id,
      );
    } else {
      sys.db.run(
        `INSERT INTO capabilities (id, schema_version, name, description, kind, domain, category, tags, publisher, origin, status, trust, tier, quality,
         context_cost, version, content_hash, snapshot_path, candidate_id, record, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        rec.id, rec.schemaVersion, rec.name, rec.description, rec.kind, rec.domain, rec.category, j(rec.tags), rec.publisher, extras.origin ?? 'discovered',
        extras.status ?? 'registered', rec.security.trust, rec.security.tier, rec.quality.total, rec.contextCost, extras.version ?? null,
        extras.contentHash ?? null, extras.snapshotPath ?? null, extras.candidateId ?? null, j(rec), now, now,
      );
    }
    // The search row shares the capability's rowid (schema 9): found directly, never by scanning the index.
    const rowid = sys.db.get<{ r: number }>('SELECT rowid r FROM capabilities WHERE id=?', rec.id)!.r;
    if (extras.body !== undefined || !existing || !sys.db.get('SELECT 1 FROM capabilities_fts WHERE rowid=?', rowid)) {
      sys.db.run('DELETE FROM capabilities_fts WHERE rowid=?', rowid);
      sys.db.run(
        'INSERT INTO capabilities_fts (rowid, id, name, description, tags, body) VALUES (?,?,?,?,?,?)',
        rowid, rec.id, rec.name.replace(/[-_]/g, ' '), rec.description, ftsTags(rec), (extras.body ?? '').slice(0, 60000),
      );
    } else {
      sys.db.run('UPDATE capabilities_fts SET name=?, description=?, tags=? WHERE rowid=?', rec.name.replace(/[-_]/g, ' '), rec.description, ftsTags(rec), rowid);
    }
    const statusNow = extras.status ?? existing?.status ?? 'registered';
    if (!existing) recordTransition(sys, rec.id, null, statusNow, extras.reason ?? 'registered', extras.by ?? 'registry');
    else if (statusNow !== existing.status) recordTransition(sys, rec.id, existing.status, statusNow, extras.reason ?? 'status set by a registry update', extras.by ?? 'registry');
    if (extras.snapshotPath && extras.contentHash) {
      sys.db.run('INSERT OR IGNORE INTO capability_versions (capability_id, content_hash, version, snapshot_path, ref, created_at) VALUES (?,?,?,?,?,?)', rec.id, extras.contentHash, extras.version ?? null, extras.snapshotPath, rec.commit || null, now);
    }
  });
  emit(sys.db, existing ? 'capability.updated' : 'capability.registered', rec.id, { name: rec.name, kind: rec.kind });
  return getCapability(sys, rec.id)!;
}

export function getCapability(sys: Sys, id: string): CapabilityRow | null {
  const r = sys.db.get<any>(`SELECT c.*, ${INSTALLED_SQL} AS installed FROM capabilities c WHERE c.id = ?`, id);
  return r ? mapCap(r) : null;
}

/** Updates fields inside the JSON record and the mirrored columns. */
export function patchCapability(sys: Sys, id: string, patch: (rec: CapabilityRecord) => void, extras: UpsertExtras = {}): CapabilityRow {
  const cur = getCapability(sys, id);
  if (!cur) throw new Error(`Unknown capability: ${id}`);
  const rec = structuredClone(cur.record);
  patch(rec);
  return upsertCapability(sys, rec, extras);
}

export function setCapabilityStatus(sys: Sys, id: string, status: CapabilityStatus, why: string) {
  transitionCapability(sys, id, status, { reason: why, by: 'registry' });
}

export interface CapabilityFilter {
  q?: string;
  kind?: string;
  domain?: string;
  status?: string;
  trust?: string;
  tier?: string;
  origin?: string;
  host?: string;
  installed?: boolean;
  minQuality?: number;
  sort?: 'relevance' | 'quality' | 'name' | 'updated';
  limit?: number;
  offset?: number;
}

export function listCapabilities(sys: Sys, f: CapabilityFilter = {}): { total: number; items: CapabilityRow[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  let from = 'capabilities c';
  let scoreSel = 'NULL AS score';
  const q = f.q ? ftsQuery(f.q) : '';
  if (q) {
    from = 'capabilities_fts f JOIN capabilities c ON c.id = f.id';
    where.push('capabilities_fts MATCH ?');
    params.push(q);
    scoreSel = '-bm25(capabilities_fts, 0.0, 8.0, 4.0, 6.0, 1.0) AS score';
  } else if (f.q) {
    where.push('0');
  }
  for (const [col, v] of [['c.kind', f.kind], ['c.domain', f.domain], ['c.status', f.status], ['c.trust', f.trust], ['c.tier', f.tier], ['c.origin', f.origin]] as const) {
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  if (f.minQuality != null) {
    where.push('c.quality >= ?');
    params.push(f.minQuality);
  }
  if (f.installed != null || f.host) {
    const hostCond = f.host ? ' AND i.host = ?' : '';
    where.push(`${f.installed === false ? 'NOT ' : ''}EXISTS (SELECT 1 FROM installations i WHERE i.capability_id = c.id AND i.status='installed'${hostCond})`);
    if (f.host) params.push(f.host);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sort = f.sort ?? (q ? 'relevance' : 'name');
  const order = { relevance: q ? 'score DESC' : 'c.name', quality: 'c.quality IS NULL, c.quality DESC, c.name', name: 'c.name COLLATE NOCASE', updated: 'c.updated_at DESC' }[sort];
  const total = sys.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${from} ${w}`, ...params)?.n ?? 0;
  // Two steps: choose the page using only filter and sort columns (index-friendly), then load full rows and installed
  // hosts for that page alone. Loading every column for every candidate row before sorting made deep pages slow.
  const page = sys.db.all<{ id: string; score: number | null }>(`SELECT c.id, ${scoreSel} FROM ${from} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, f.limit ?? 50, f.offset ?? 0);
  if (!page.length) return { total, items: [] };
  const full = new Map(sys.db.all<any>(`SELECT c.*, ${INSTALLED_SQL} AS installed FROM capabilities c WHERE c.id IN (${page.map(() => '?').join(',')})`, ...page.map((p) => p.id)).map((r) => [r.id, r]));
  return { total, items: page.filter((p) => full.has(p.id)).map((p) => mapCap({ ...full.get(p.id), score: p.score })) };
}

export function facets(sys: Sys) {
  const g = (col: string) => sys.db.all<{ v: string; n: number }>(`SELECT ${col} v, COUNT(*) n FROM capabilities GROUP BY ${col} ORDER BY n DESC`);
  return { kind: g('kind'), domain: g('domain'), status: g('status'), trust: g('trust'), tier: g('tier'), origin: g('origin') };
}

/* ---------- relations (capability graph) ---------- */

export function relate(sys: Sys, src: string, rel: string, dst: string, weight = 1, evidence = '') {
  sys.db.run('INSERT INTO relations (src, rel, dst, weight, evidence, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(src, rel, dst) DO UPDATE SET weight=excluded.weight, evidence=excluded.evidence', src, rel, dst, weight, evidence, nowIso());
}
export function relationsOf(sys: Sys, id: string) {
  return sys.db.all<{ src: string; rel: string; dst: string; weight: number; evidence: string }>('SELECT src, rel, dst, weight, evidence FROM relations WHERE src=? OR dst=? ORDER BY rel', id, id);
}

/* ---------- candidates ---------- */

export interface CandidateRow {
  id: string;
  sourceId: string;
  externalId: string;
  kind: string;
  name: string;
  description: string;
  url: string | null;
  repo: string | null;
  ref: string | null;
  path: string | null;
  publisher: string | null;
  licenseSpdx: string | null;
  licenseEvidence: string | null;
  stars: number | null;
  pushedAt: string | null;
  topics: string[];
  upstreamVersion: string | null;
  signals: Record<string, any>;
  raw: any;
  state: string;
  rank: number;
  rankReasons: string[];
  recommendedAction: string | null;
  files: { path: string; size: number; sha256: string }[];
  contentHash: string | null;
  normHash: string | null;
  quarantinePath: string | null;
  duplicateOf: string | null;
  overlap: { id: string; name: string; similarity: number; basis: string }[];
  capabilityId: string | null;
  updateAvailable: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function mapCandidate(r: any): CandidateRow {
  return {
    id: r.id, sourceId: r.source_id, externalId: r.external_id, kind: r.kind, name: r.name, description: r.description, url: r.url, repo: r.repo, ref: r.ref,
    path: r.path, publisher: r.publisher, licenseSpdx: r.license_spdx, licenseEvidence: r.license_evidence, stars: r.stars, pushedAt: r.pushed_at,
    topics: pj(r.topics, []), upstreamVersion: r.upstream_version, signals: pj(r.signals, {}), raw: pj(r.raw, null), state: r.state, rank: r.rank,
    rankReasons: pj(r.rank_reasons, []), recommendedAction: r.recommended_action, files: pj(r.files, []), contentHash: r.content_hash, normHash: r.norm_hash,
    quarantinePath: r.quarantine_path, duplicateOf: r.duplicate_of, overlap: pj(r.overlap, []), capabilityId: r.capability_id,
    updateAvailable: !!r.update_available, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
  };
}
export function getCandidate(sys: Sys, id: string): CandidateRow | null {
  const r = sys.db.get<any>('SELECT * FROM candidates WHERE id=?', id);
  return r ? mapCandidate(r) : null;
}
export function listCandidates(sys: Sys, f: { state?: string; source?: string; kind?: string; q?: string; limit?: number; offset?: number; sort?: 'rank' | 'recent' | 'name' } = {}): { total: number; items: CandidateRow[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.state) {
    where.push('state = ?');
    params.push(f.state);
  }
  if (f.source) {
    where.push('source_id = ?');
    params.push(f.source);
  }
  if (f.kind) {
    where.push('kind = ?');
    params.push(f.kind);
  }
  if (f.q) {
    where.push('(name LIKE ? OR description LIKE ? OR repo LIKE ?)');
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = { rank: 'rank DESC, name', recent: 'last_seen_at DESC', name: 'name COLLATE NOCASE' }[f.sort ?? 'rank'];
  const total = sys.db.get<{ n: number }>(`SELECT COUNT(*) n FROM candidates ${w}`, ...params)?.n ?? 0;
  const rows = sys.db.all<any>(`SELECT * FROM candidates ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, f.limit ?? 50, f.offset ?? 0);
  return { total, items: rows.map(mapCandidate) };
}

/* ---------- overview counters (all real, straight from the DB) ---------- */

export function overview(sys: Sys) {
  const n = (sql: string, ...p: unknown[]) => sys.db.get<{ n: number }>(sql, ...p)?.n ?? 0;
  const group = (sql: string) => Object.fromEntries(sys.db.all<{ k: string; n: number }>(sql).map((r) => [r.k, r.n]));
  return {
    capabilities: { total: n('SELECT COUNT(*) n FROM capabilities'), byStatus: group('SELECT status k, COUNT(*) n FROM capabilities GROUP BY status'), byKind: group('SELECT kind k, COUNT(*) n FROM capabilities GROUP BY kind'), byOrigin: group('SELECT origin k, COUNT(*) n FROM capabilities GROUP BY origin') },
    candidates: { total: n('SELECT COUNT(*) n FROM candidates'), byState: group('SELECT state k, COUNT(*) n FROM candidates GROUP BY state'), updates: n('SELECT COUNT(*) n FROM candidates WHERE update_available=1') },
    sources: sys.db.all<any>('SELECT id, title, kind, official, enabled, health, health_detail, last_scan_at FROM sources ORDER BY id'),
    lastScan: sys.db.get<any>('SELECT id, source_id, mode, query, status, found, added, updated, started_at, finished_at FROM scan_runs ORDER BY id DESC LIMIT 1') ?? null,
    scans: n('SELECT COUNT(*) n FROM scan_runs'),
    installations: { active: n("SELECT COUNT(*) n FROM installations WHERE status='installed' AND scope != 'external'"), external: n("SELECT COUNT(*) n FROM installations WHERE status='installed' AND scope='external'"), real: n("SELECT COUNT(*) n FROM installations WHERE status='installed' AND scope='real'"), failed: n("SELECT COUNT(*) n FROM installations WHERE status='failed'"), rolledBack: n("SELECT COUNT(*) n FROM installations WHERE status='rolled_back'") },
    pendingApproval: n("SELECT COUNT(*) n FROM capabilities WHERE status='registered' AND origin != 'host-inventory'"),
    security: { blocked: n("SELECT COUNT(*) n FROM capabilities WHERE status='blocked'") + n("SELECT COUNT(*) n FROM candidates WHERE state='blocked'"), criticalAudits: n('SELECT COUNT(*) n FROM audits WHERE critical > 0'), quarantined: n("SELECT COUNT(*) n FROM candidates WHERE state IN ('quarantined','audited','blocked')") },
    routing: { decisions: n('SELECT COUNT(*) n FROM route_decisions'), activations: n('SELECT COUNT(*) n FROM activations'), openGaps: n("SELECT COUNT(*) n FROM gaps WHERE status='open'") },
    forge: { candidates: n('SELECT COUNT(*) n FROM forge_candidates'), evalRuns: n('SELECT COUNT(*) n FROM eval_runs') },
    events: n('SELECT COUNT(*) n FROM events'),
    /** When the skills already installed on this machine were last indexed (null: never), and what was found. */
    inventory: (() => {
      const e = sys.db.get<{ ts: string; payload: string | null }>("SELECT ts, payload FROM events WHERE type = 'inventory.indexed' ORDER BY id DESC LIMIT 1");
      if (!e) return null;
      const p = e.payload ? JSON.parse(e.payload) : {};
      return { lastIndexedAt: e.ts, indexed: Number(p.indexed ?? 0), flagged: Number(p.flagged ?? 0) };
    })(),
  };
}
